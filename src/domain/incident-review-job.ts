import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

export const incidentReviewRequestedV1Schema = z
  .object({
    type: z.literal('incident.review.requested'),
    version: z.literal(1),
    jobId: nonEmptyString,
    tenantId: nonEmptyString,
    requestedAt: z.iso.datetime(),
    requestedTitle: z.string().trim().min(1).max(160),
    source: z
      .object({
        provider: z.literal('slack'),
        eventId: nonEmptyString,
        workspaceId: nonEmptyString,
        channelId: nonEmptyString,
        messageTs: nonEmptyString,
        threadTs: nonEmptyString.optional(),
        userId: nonEmptyString,
      })
      .strict(),
  })
  .strict()
  .superRefine((job, context) => {
    // The initial tenancy model is one tenant per Slack workspace. Do not trust
    // the duplicated envelope field if a producer or stored message is
    // compromised; both identities must describe the same boundary.
    if (job.tenantId !== job.source.workspaceId) {
      context.addIssue({
        code: 'custom',
        path: ['tenantId'],
        message: 'Tenant must match the source Slack workspace',
      });
    }
  });

export type IncidentReviewRequestedV1 = z.infer<
  typeof incidentReviewRequestedV1Schema
>;

const slackChannelId = z.string().regex(/^C[A-Z0-9]{1,63}$/);
const slackTimestamp = z.string().regex(/^\d{1,20}\.\d{1,20}$/);

export const incidentReviewRequestedV2Schema = z
  .object({
    type: z.literal('incident.review.requested'),
    version: z.literal(2),
    jobId: nonEmptyString,
    tenantId: nonEmptyString,
    requestedAt: z.iso.datetime(),
    requestedTitle: z.string().trim().min(1).max(160),
    source: z
      .object({
        provider: z.literal('slack'),
        eventId: nonEmptyString.max(256),
        workspaceId: z.string().regex(/^T[A-Z0-9]{1,63}$/),
        channelId: slackChannelId,
        messageTs: slackTimestamp,
        threadTs: slackTimestamp.optional(),
        userId: z.string().regex(/^[UW][A-Z0-9]{1,63}$/),
      })
      .strict(),
    scope: z
      .object({
        startedAt: z.iso.datetime(),
        endedAt: z.iso.datetime(),
        reviewerUserId: z
          .string()
          .regex(/^[UW][A-Z0-9]{1,63}$/)
          .optional(),
        evidenceRetentionDays: z.number().int().min(1).max(365),
        channels: z
          .array(
            z
              .object({
                channelId: slackChannelId,
                role: z.enum(['PRIMARY', 'ADDITIONAL']),
                anchorThreadTs: z.array(slackTimestamp).max(5),
              })
              .strict(),
          )
          .min(1)
          .max(5),
      })
      .strict(),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.tenantId !== job.source.workspaceId) {
      context.addIssue({
        code: 'custom',
        path: ['tenantId'],
        message: 'Tenant must match the source Slack workspace',
      });
    }
    const startedAt = Date.parse(job.scope.startedAt);
    const endedAt = Date.parse(job.scope.endedAt);
    if (endedAt <= startedAt) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'endedAt'],
        message: 'Incident end must follow its start',
      });
    }
    if (endedAt - startedAt > 7 * 86_400_000) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'endedAt'],
        message: 'Incident collection window must not exceed seven days',
      });
    }
    const channelIds = job.scope.channels.map((channel) => channel.channelId);
    if (new Set(channelIds).size !== channelIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'channels'],
        message: 'Incident channels must be unique',
      });
    }
    if (
      job.scope.channels.filter((channel) => channel.role === 'PRIMARY')
        .length !== 1
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scope', 'channels'],
        message: 'Exactly one primary channel is required',
      });
    }
  });

export type IncidentReviewRequestedV2 = z.infer<
  typeof incidentReviewRequestedV2Schema
>;

export type IncidentReviewJob =
  IncidentReviewRequestedV1 | IncidentReviewRequestedV2;

export function parseIncidentReviewJob(value: unknown): IncidentReviewJob {
  return z
    .discriminatedUnion('version', [
      incidentReviewRequestedV1Schema,
      incidentReviewRequestedV2Schema,
    ])
    .parse(value);
}
