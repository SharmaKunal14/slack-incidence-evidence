import type {
  ReviewClassification,
  ReviewReportSection,
} from '../review/incident-review.js';

export interface ApprovedReportPublicationStatement {
  readonly text: string;
  readonly classification: ReviewClassification;
}

export interface ApprovedReportPublicationSection {
  readonly sectionType: ReviewReportSection['sectionType'];
  readonly statements: readonly ApprovedReportPublicationStatement[];
}

export interface ApprovedReportDocument {
  readonly incidentId: string;
  readonly title: string;
  readonly severity: string;
  readonly revisionNumber: number;
  readonly approvedAt: Date;
  readonly sections: readonly ApprovedReportPublicationSection[];
}

export interface PublishedReportPage {
  readonly pageId: string;
  readonly pageUrl: string;
}

export interface ApprovedReportPublisher {
  publish(document: ApprovedReportDocument): Promise<PublishedReportPage>;
}

export class ReportPublicationProviderError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryAfterSeconds: number | null = null,
    options?: ErrorOptions,
  ) {
    super('Approved report publication provider request failed', options);
    this.name = 'ReportPublicationProviderError';
  }
}
