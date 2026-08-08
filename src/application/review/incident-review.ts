import { z } from 'zod';
import { cognitoSubjectSchema } from '../identity/cognito-subject.js';
import {
  INCIDENT_REPORT_SECTION_TYPES,
  type IncidentReportSectionType,
} from '../report/incident-report.js';

export const REVIEW_CLASSIFICATIONS = [
  'directly_observed',
  'corroborated',
  'participant_assertion',
  'hypothesis',
  'correlated_inference',
  'disputed',
  'unknown',
  'human_confirmed',
] as const;

export type ReviewClassification = (typeof REVIEW_CLASSIFICATIONS)[number];
export type ReviewDecision = 'KEEP' | 'EDIT' | 'EXCLUDE' | 'ADD';

export interface ReviewerIdentity {
  readonly subject: string;
}

export interface ReviewInboxCursor {
  readonly createdAt: string;
  readonly incidentId: string;
}

export interface ReviewInboxItem {
  readonly incidentId: string;
  readonly title: string;
  readonly severity: string;
  readonly status: 'NEEDS_REVIEW' | 'APPROVED';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly incidentVersion: number;
  readonly reportDraftId: string;
  readonly claimCount: number;
  readonly timelineEventCount: number;
  readonly openQuestionCount: number;
  readonly contradictionCount: number;
  readonly latestRevisionId: string | null;
  readonly latestRevisionNumber: number | null;
  readonly latestRevisionStatus: 'DRAFT' | 'APPROVED' | null;
}

export interface ReviewInboxPage {
  readonly items: readonly ReviewInboxItem[];
  readonly nextCursor: ReviewInboxCursor | null;
}

export const assignIncidentReviewerCommandSchema = z
  .object({
    expectedIncidentVersion: z.number().int().nonnegative(),
    memberSubject: cognitoSubjectSchema.nullable(),
    clientRequestId: z.uuid(),
  })
  .strict();

export interface IncidentReviewerAssignment {
  readonly incidentId: string;
  readonly workspaceId: string;
  readonly assignedMemberSubject: string | null;
  readonly assignedSlackUserId: string | null;
  readonly incidentVersion: number;
  readonly updatedAt: string;
}

export interface ReviewEvidence {
  readonly id: string;
  readonly sourceType: string;
  readonly occurredAt: string;
  readonly authorReference: string | null;
  readonly content: string;
  readonly contentTruncated: boolean;
  readonly sourceUri: string | null;
}

export interface ReviewEvidenceCoverage {
  readonly sourceId: string;
  readonly provider: string;
  readonly sourceName: string;
  readonly state: string;
  readonly messageCount: number;
  readonly permissionOutcome: string;
  readonly reason: string | null;
}

export interface ReviewClaim {
  readonly id: string;
  readonly statement: string;
  readonly classification: ReviewClassification;
  readonly reviewStatus: string;
  readonly supportingEvidenceIds: readonly string[];
  readonly contradictingEvidenceIds: readonly string[];
}

export interface ReviewTimelineEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly classification: ReviewClassification;
  readonly evidenceIds: readonly string[];
}

export interface ReviewReportStatement {
  readonly id: string;
  readonly sectionType: IncidentReportSectionType;
  readonly position: number;
  readonly statementType: 'claim' | 'timeline';
  readonly text: string;
  readonly classification: ReviewClassification;
  readonly claimIds: readonly string[];
  readonly timelineEventIds: readonly string[];
}

export interface ReviewReportSection {
  readonly sectionType: IncidentReportSectionType;
  readonly position: number;
  readonly statements: readonly ReviewReportStatement[];
}

export interface ReportRevisionSummary {
  readonly id: string;
  readonly revisionNumber: number;
  readonly status: 'DRAFT' | 'APPROVED';
  readonly createdAt: string;
  readonly statementCount: number;
  readonly acknowledgedContradictions: boolean;
  readonly acknowledgedOpenQuestions: boolean;
}

export interface ReviewRevisionStatement {
  readonly originalStatementId: string | null;
  readonly sectionType: IncidentReportSectionType;
  readonly position: number;
  readonly decision: ReviewDecision;
  readonly text: string | null;
  readonly classification: ReviewClassification | null;
  readonly claimIds: readonly string[];
  readonly timelineEventIds: readonly string[];
}

export interface ReviewQuestionAnswer {
  readonly questionId: string;
  readonly question: string;
  readonly answer: string;
}

export interface ReportRevisionDetail extends ReportRevisionSummary {
  readonly statements: readonly ReviewRevisionStatement[];
  readonly questionAnswers: readonly ReviewQuestionAnswer[];
}

export interface IncidentReviewBundle {
  readonly accessMode: 'EDITOR' | 'VIEWER';
  readonly assignment: {
    readonly workspaceId: string;
    readonly canManage: boolean;
    readonly assignedMemberSubject: string | null;
    readonly assignedSlackUserId: string | null;
  };
  readonly incident: {
    readonly id: string;
    readonly title: string;
    readonly severity: string;
    readonly status: 'NEEDS_REVIEW' | 'APPROVED';
    readonly version: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly reportDraft: {
    readonly id: string;
    readonly draftVersion: number;
    readonly renderedMarkdown: string;
  };
  readonly sections: readonly ReviewReportSection[];
  readonly claims: readonly ReviewClaim[];
  readonly timeline: readonly ReviewTimelineEvent[];
  readonly evidence: readonly ReviewEvidence[];
  readonly evidenceCoverage?: readonly ReviewEvidenceCoverage[];
  readonly openQuestions: readonly {
    readonly id: string;
    readonly question: string;
    readonly evidenceIds: readonly string[];
  }[];
  readonly revisions: readonly ReportRevisionSummary[];
  readonly latestRevision: ReportRevisionDetail | null;
}

export interface ReviewStatementDecisionInput {
  readonly statementId: string;
  readonly decision: ReviewDecision;
  readonly text?: string;
  readonly classification?: ReviewClassification;
}

export interface ReviewAdditionalStatementInput {
  readonly clientStatementId: string;
  readonly sectionType: IncidentReportSectionType;
  readonly text: string;
  readonly classification: ReviewClassification;
  readonly claimIds: readonly string[];
  readonly timelineEventIds: readonly string[];
}

export interface ResolvedReviewStatement {
  readonly id: string;
  readonly originalStatementId: string | null;
  readonly sectionType: IncidentReportSectionType;
  readonly position: number;
  readonly decision: ReviewDecision;
  readonly text: string | null;
  readonly classification: ReviewClassification | null;
  readonly claimIds: readonly string[];
  readonly timelineEventIds: readonly string[];
}

export interface ResolvedReviewQuestionAnswer {
  readonly id: string;
  readonly questionId: string;
  readonly question: string;
  readonly answer: string;
}

export interface ReportRevision {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly reportDraftId: string;
  readonly revisionNumber: number;
  readonly status: 'DRAFT' | 'APPROVED';
  readonly createdBySubject: string;
  readonly acknowledgedContradictions: boolean;
  readonly acknowledgedOpenQuestions: boolean;
  readonly statementCount: number;
  readonly renderedMarkdown: string;
  readonly contentSha256: string;
  readonly createdAt: Date;
  readonly approvedBySubject: string | null;
  readonly approvedAt: Date | null;
}

const safeIdSchema = z.string().trim().min(1).max(128);
const reviewTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_000)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
          codePoint > 31 ||
          codePoint === 9 ||
          codePoint === 10 ||
          codePoint === 13
        );
      }),
    { message: 'Review text contains unsupported control characters' },
  );

export const createReportRevisionCommandSchema = z
  .object({
    incidentId: z.uuid(),
    reportDraftId: z.uuid(),
    expectedIncidentVersion: z.number().int().nonnegative(),
    clientRequestId: z.uuid(),
    acknowledgedContradictions: z.boolean(),
    acknowledgedOpenQuestions: z.boolean(),
    questionAnswers: z
      .array(
        z
          .object({
            questionId: safeIdSchema,
            answer: reviewTextSchema,
          })
          .strict(),
      )
      .max(100)
      .default([]),
    decisions: z
      .array(
        z
          .object({
            statementId: safeIdSchema,
            decision: z.enum(['KEEP', 'EDIT', 'EXCLUDE']),
            text: reviewTextSchema.optional(),
            classification: z.enum(REVIEW_CLASSIFICATIONS).optional(),
          })
          .strict()
          .superRefine((decision, context) => {
            const hasEditableContent =
              decision.text !== undefined &&
              decision.classification !== undefined;
            if (decision.decision === 'EDIT' && !hasEditableContent) {
              context.addIssue({
                code: 'custom',
                message: 'Edited statements require text and classification',
              });
            }
            if (
              decision.decision !== 'EDIT' &&
              (decision.text !== undefined ||
                decision.classification !== undefined)
            ) {
              context.addIssue({
                code: 'custom',
                message:
                  'Only edited statements may supply replacement content',
              });
            }
          }),
      )
      .min(1)
      .max(300),
    additionalStatements: z
      .array(
        z
          .object({
            clientStatementId: z.uuid(),
            sectionType: z.enum(INCIDENT_REPORT_SECTION_TYPES),
            text: reviewTextSchema,
            classification: z.enum(REVIEW_CLASSIFICATIONS),
            claimIds: z.array(safeIdSchema).max(20),
            timelineEventIds: z.array(safeIdSchema).max(20),
          })
          .strict()
          .superRefine((statement, context) => {
            if (
              statement.claimIds.length === 0 &&
              statement.timelineEventIds.length === 0
            ) {
              context.addIssue({
                code: 'custom',
                message: 'Reviewer statements require at least one source',
              });
            }
            if (
              new Set(statement.claimIds).size !== statement.claimIds.length
            ) {
              context.addIssue({
                code: 'custom',
                message: 'Duplicate claim link',
              });
            }
            if (
              new Set(statement.timelineEventIds).size !==
              statement.timelineEventIds.length
            ) {
              context.addIssue({
                code: 'custom',
                message: 'Duplicate timeline event link',
              });
            }
          }),
      )
      .max(100)
      .default([]),
  })
  .strict()
  .superRefine((command, context) => {
    const statementIds = command.decisions.map(
      (decision) => decision.statementId,
    );
    if (new Set(statementIds).size !== statementIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate statement decision',
      });
    }
    const questionIds = command.questionAnswers.map(
      (answer) => answer.questionId,
    );
    if (new Set(questionIds).size !== questionIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate open-question answer',
      });
    }
    const clientStatementIds = command.additionalStatements.map(
      (statement) => statement.clientStatementId,
    );
    if (new Set(clientStatementIds).size !== clientStatementIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate reviewer statement identifier',
      });
    }
  });

export const approveReportRevisionCommandSchema = z
  .object({
    incidentId: z.uuid(),
    revisionId: z.uuid(),
    expectedIncidentVersion: z.number().int().nonnegative(),
    clientRequestId: z.uuid(),
  })
  .strict();

export function parseSectionType(value: string): IncidentReportSectionType {
  const normalized = value.toLowerCase();
  if (
    INCIDENT_REPORT_SECTION_TYPES.includes(
      normalized as IncidentReportSectionType,
    )
  ) {
    return normalized as IncidentReportSectionType;
  }
  throw new ReviewConfigurationError('Unsupported report section type');
}

export function parseReviewClassification(value: string): ReviewClassification {
  const normalized = value.toLowerCase();
  if (REVIEW_CLASSIFICATIONS.includes(normalized as ReviewClassification)) {
    return normalized as ReviewClassification;
  }
  throw new ReviewConfigurationError('Unsupported review classification');
}

export function classificationCaution(
  classification: ReviewClassification,
): number {
  switch (classification) {
    case 'human_confirmed':
    case 'directly_observed':
    case 'corroborated':
      return 0;
    case 'participant_assertion':
      return 1;
    case 'correlated_inference':
      return 2;
    case 'hypothesis':
      return 3;
    case 'disputed':
      return 4;
    case 'unknown':
      return 5;
  }
}

export class ReviewAuthorizationError extends Error {
  public constructor() {
    super('Reviewer is not authorized');
    this.name = 'ReviewAuthorizationError';
  }
}

export class ReviewNotFoundError extends Error {
  public constructor() {
    super('Review resource was not found');
    this.name = 'ReviewNotFoundError';
  }
}

export class ReviewConflictError extends Error {
  public constructor(message = 'Review resource was modified concurrently') {
    super(message);
    this.name = 'ReviewConflictError';
  }
}

export class ReviewValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReviewValidationError';
  }
}

export class ReviewConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReviewConfigurationError';
  }
}
