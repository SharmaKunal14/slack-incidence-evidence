import type {
  ApprovedReportDocument,
  ReportPublicationProvider,
} from './approved-report-publisher.js';

export type ApprovedReportPublicationStatus = 'PENDING' | 'PAGE_PUBLISHED';

export interface ApprovedReportPublicationJob {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly revisionId: string;
  readonly status: ApprovedReportPublicationStatus;
  readonly attemptCount: number;
  readonly publisher: ReportPublicationProvider | null;
  readonly publishedPageId: string | null;
  readonly publishedPageUrl: string | null;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly document: ApprovedReportDocument;
}

export interface ApprovedReportPublicationRepository {
  claimNext(input: {
    readonly workerId: string;
    readonly claimedAt: Date;
    readonly leaseExpiresAt: Date;
    readonly maxAttempts: number;
    readonly publisher: ReportPublicationProvider;
  }): Promise<ApprovedReportPublicationJob | null>;
  markPagePublished(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly publisher: ReportPublicationProvider;
    readonly pageId: string;
    readonly pageUrl: string;
    readonly publishedAt: Date;
  }): Promise<void>;
  markComplete(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly slackMessageTs: string;
    readonly completedAt: Date;
  }): Promise<void>;
  recordFailure(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly errorCode: string;
    readonly retryAt: Date;
    readonly failedAt: Date;
    readonly terminal: boolean;
  }): Promise<void>;
}
