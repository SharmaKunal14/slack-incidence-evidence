import { z } from 'zod';

export const classificationValues = [
  'directly_observed',
  'corroborated',
  'participant_assertion',
  'hypothesis',
  'correlated_inference',
  'disputed',
  'unknown',
  'human_confirmed',
] as const;

export const configurationSchema = z
  .object({
    apiBaseUrl: z.url(),
    cognitoBaseUrl: z.url(),
    cognitoClientId: z.string().min(1).max(128),
    redirectUri: z.url(),
  })
  .strict();

export const inboxItemSchema = z
  .object({
    incidentId: z.uuid(),
    title: z.string(),
    severity: z.string(),
    status: z.enum(['NEEDS_REVIEW', 'APPROVED']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    incidentVersion: z.number().int().nonnegative(),
    reportDraftId: z.uuid(),
    claimCount: z.number().int().nonnegative(),
    timelineEventCount: z.number().int().nonnegative(),
    openQuestionCount: z.number().int().nonnegative(),
    contradictionCount: z.number().int().nonnegative(),
    latestRevisionId: z.uuid().nullable(),
    latestRevisionNumber: z.number().int().positive().nullable(),
    latestRevisionStatus: z.enum(['DRAFT', 'APPROVED']).nullable(),
  })
  .strict();

export const inboxSchema = z
  .object({
    items: z.array(inboxItemSchema).max(50),
    nextCursor: z.string().max(1024).nullable(),
  })
  .strict();

export const statementSchema = z
  .object({
    id: z.string(),
    sectionType: z.string(),
    position: z.number().int().nonnegative(),
    statementType: z.enum(['claim', 'timeline']),
    text: z.string(),
    classification: z.enum(classificationValues),
    claimIds: z.array(z.string()),
    timelineEventIds: z.array(z.string()),
  })
  .strict();

const revisionSummarySchema = z
  .object({
    id: z.uuid(),
    revisionNumber: z.number().int().positive(),
    status: z.enum(['DRAFT', 'APPROVED']),
    createdAt: z.iso.datetime(),
    statementCount: z.number().int().positive(),
    acknowledgedContradictions: z.boolean(),
    acknowledgedOpenQuestions: z.boolean(),
  })
  .strict();

const revisionStatementSchema = z
  .object({
    originalStatementId: z.string(),
    sectionType: z.string(),
    position: z.number().int().nonnegative(),
    decision: z.enum(['KEEP', 'EDIT', 'EXCLUDE']),
    text: z.string().nullable(),
    classification: z.enum(classificationValues).nullable(),
  })
  .strict();

export const bundleSchema = z
  .object({
    incident: z
      .object({
        id: z.uuid(),
        title: z.string(),
        severity: z.string(),
        status: z.enum(['NEEDS_REVIEW', 'APPROVED']),
        version: z.number().int().nonnegative(),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
      })
      .strict(),
    reportDraft: z
      .object({
        id: z.uuid(),
        draftVersion: z.number().int().positive(),
        renderedMarkdown: z.string(),
      })
      .strict(),
    sections: z.array(
      z
        .object({
          sectionType: z.string(),
          position: z.number().int().nonnegative(),
          statements: z.array(statementSchema),
        })
        .strict(),
    ),
    claims: z.array(
      z
        .object({
          id: z.string(),
          statement: z.string(),
          classification: z.enum(classificationValues),
          reviewStatus: z.string(),
          supportingEvidenceIds: z.array(z.string()),
          contradictingEvidenceIds: z.array(z.string()),
        })
        .strict(),
    ),
    timeline: z.array(
      z
        .object({
          id: z.string(),
          occurredAt: z.iso.datetime(),
          summary: z.string(),
          classification: z.enum(classificationValues),
          evidenceIds: z.array(z.string()),
        })
        .strict(),
    ),
    evidence: z.array(
      z
        .object({
          id: z.string(),
          sourceType: z.string(),
          occurredAt: z.iso.datetime(),
          authorReference: z.string().nullable(),
          content: z.string(),
          contentTruncated: z.boolean(),
          sourceUri: z.string().nullable(),
        })
        .strict(),
    ),
    openQuestions: z.array(
      z.object({ id: z.string(), question: z.string() }).strict(),
    ),
    revisions: z.array(revisionSummarySchema).max(50),
    latestRevision: revisionSummarySchema
      .extend({ statements: z.array(revisionStatementSchema).max(300) })
      .strict()
      .nullable(),
  })
  .strict();

export const revisionResponseSchema = z
  .object({
    revision: z
      .object({
        id: z.uuid(),
        revisionNumber: z.number().int().positive(),
        status: z.enum(['DRAFT', 'APPROVED']),
      })
      .passthrough(),
  })
  .strict();

export type Bundle = z.infer<typeof bundleSchema>;
export type Classification = (typeof classificationValues)[number];
export type Configuration = z.infer<typeof configurationSchema>;
export type InboxItem = z.infer<typeof inboxItemSchema>;
export type Statement = z.infer<typeof statementSchema>;
