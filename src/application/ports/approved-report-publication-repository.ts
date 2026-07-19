import type { ApprovedReportDocument } from './approved-report-publisher.js';

export type ApprovedReportPublicationStatus = 'PENDING' | 'NOTION_PUBLISHED';

export interface ApprovedReportPublicationJob {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly revisionId: string;
  readonly status: ApprovedReportPublicationStatus;
  readonly attemptCount: number;
  readonly notionPageId: string | null;
  readonly notionPageUrl: string | null;
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
  }): Promise<ApprovedReportPublicationJob | null>;
  markNotionPublished(input: {
    readonly jobId: string;
    readonly workerId: string;
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
