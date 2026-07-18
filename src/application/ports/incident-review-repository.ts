import type {
  IncidentReviewBundle,
  ReportRevision,
  ResolvedReviewStatement,
  ReviewInboxCursor,
  ReviewInboxPage,
  ReviewerIdentity,
} from '../review/incident-review.js';

export interface CreateReportRevisionInput {
  readonly id: string;
  readonly reviewer: ReviewerIdentity;
  readonly incidentId: string;
  readonly reportDraftId: string;
  readonly expectedIncidentVersion: number;
  readonly clientRequestId: string;
  readonly requestSha256: string;
  readonly acknowledgedContradictions: boolean;
  readonly acknowledgedOpenQuestions: boolean;
  readonly statements: readonly ResolvedReviewStatement[];
  readonly renderedMarkdown: string;
  readonly contentSha256: string;
  readonly createdAt: Date;
  readonly auditEventId: string;
}

export interface ApproveReportRevisionInput {
  readonly approvalId: string;
  readonly auditEventId: string;
  readonly reviewer: ReviewerIdentity;
  readonly incidentId: string;
  readonly revisionId: string;
  readonly expectedIncidentVersion: number;
  readonly clientRequestId: string;
  readonly approvedAt: Date;
}

export interface IncidentReviewRepository {
  listInbox(
    reviewer: ReviewerIdentity,
    limit: number,
    cursor: ReviewInboxCursor | null,
  ): Promise<{ readonly authorized: boolean; readonly page: ReviewInboxPage }>;
  loadBundle(
    reviewer: ReviewerIdentity,
    incidentId: string,
  ): Promise<IncidentReviewBundle | null>;
  createRevision(input: CreateReportRevisionInput): Promise<ReportRevision>;
  approveRevision(input: ApproveReportRevisionInput): Promise<ReportRevision>;
}
