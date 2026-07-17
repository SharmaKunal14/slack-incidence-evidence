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
  .strict();

export type IncidentReviewRequestedV1 = z.infer<
  typeof incidentReviewRequestedV1Schema
>;

export type IncidentReviewJob = IncidentReviewRequestedV1;

export function parseIncidentReviewJob(value: unknown): IncidentReviewJob {
  return incidentReviewRequestedV1Schema.parse(value);
}
