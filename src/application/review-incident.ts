import { createHash } from 'node:crypto';
import type { Clock } from './ports/clock.js';
import type { IdGenerator } from './ports/id-generator.js';
import type { IncidentReviewRepository } from './ports/incident-review-repository.js';
import {
  approveReportRevisionCommandSchema,
  classificationCaution,
  createReportRevisionCommandSchema,
  ReviewAuthorizationError,
  ReviewConflictError,
  ReviewNotFoundError,
  ReviewValidationError,
  type IncidentReviewBundle,
  type ReportRevision,
  type ReportRevisionDetail,
  type ResolvedReviewStatement,
  type ReviewInboxCursor,
  type ReviewInboxPage,
  type ReviewerIdentity,
} from './review/incident-review.js';
import { renderReviewedReportMarkdown } from './review/render-reviewed-report.js';

export class ListIncidentReviews {
  public constructor(private readonly reviews: IncidentReviewRepository) {}

  public async execute(input: {
    readonly reviewer: ReviewerIdentity;
    readonly limit: number;
    readonly cursor: ReviewInboxCursor | null;
  }): Promise<ReviewInboxPage> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50
    ) {
      throw new ReviewValidationError(
        'Review page limit must be between 1 and 50',
      );
    }
    const result = await this.reviews.listInbox(
      input.reviewer,
      input.limit,
      input.cursor,
    );
    if (!result.authorized) {
      throw new ReviewAuthorizationError();
    }
    return result.page;
  }
}

export class GetIncidentReview {
  public constructor(private readonly reviews: IncidentReviewRepository) {}

  public async execute(input: {
    readonly reviewer: ReviewerIdentity;
    readonly incidentId: string;
  }): Promise<IncidentReviewBundle> {
    const bundle = await this.reviews.loadBundle(
      input.reviewer,
      input.incidentId,
    );
    if (bundle === null) {
      throw new ReviewNotFoundError();
    }
    return bundle;
  }
}

export class GetReportRevision {
  public constructor(private readonly reviews: IncidentReviewRepository) {}

  public async execute(input: {
    readonly reviewer: ReviewerIdentity;
    readonly incidentId: string;
    readonly revisionId: string;
  }): Promise<ReportRevisionDetail> {
    const revision = await this.reviews.loadRevision(
      input.reviewer,
      input.incidentId,
      input.revisionId,
    );
    if (revision === null) {
      throw new ReviewNotFoundError();
    }
    return revision;
  }
}

export class CreateReportRevision {
  public constructor(
    private readonly reviews: IncidentReviewRepository,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  public async execute(input: {
    readonly reviewer: ReviewerIdentity;
    readonly command: unknown;
  }): Promise<ReportRevision> {
    const command = createReportRevisionCommandSchema.parse(input.command);
    const bundle = await this.reviews.loadBundle(
      input.reviewer,
      command.incidentId,
    );
    if (bundle === null) {
      throw new ReviewNotFoundError();
    }
    if (bundle.incident.status !== 'NEEDS_REVIEW') {
      throw new ReviewConflictError('Incident is not awaiting review');
    }
    if (bundle.incident.version !== command.expectedIncidentVersion) {
      throw new ReviewConflictError();
    }
    if (bundle.reportDraft.id !== command.reportDraftId) {
      throw new ReviewConflictError('Report draft has been superseded');
    }

    const sourceStatements = bundle.sections.flatMap(
      (section) => section.statements,
    );
    if (sourceStatements.length !== command.decisions.length) {
      throw new ReviewValidationError(
        'Every report statement requires exactly one review decision',
      );
    }
    const sources = new Map(
      sourceStatements.map((statement) => [statement.id, statement]),
    );
    const statements = command.decisions.map((decision) => {
      const source = sources.get(decision.statementId);
      if (source === undefined) {
        throw new ReviewValidationError(
          'Review decision references an unknown report statement',
        );
      }
      return resolveStatement(this.idGenerator.generate(), source, decision);
    });
    if (statements.every((statement) => statement.decision === 'EXCLUDE')) {
      throw new ReviewValidationError(
        'A report revision must include at least one statement',
      );
    }

    const contradictionCount = bundle.claims.filter(
      (claim) =>
        claim.classification === 'disputed' ||
        claim.contradictingEvidenceIds.length > 0,
    ).length;
    if (contradictionCount > 0 && !command.acknowledgedContradictions) {
      throw new ReviewValidationError(
        'Material contradictions must be acknowledged before saving a revision',
      );
    }
    if (bundle.openQuestions.length > 0 && !command.acknowledgedOpenQuestions) {
      throw new ReviewValidationError(
        'Open questions must be acknowledged before saving a revision',
      );
    }

    const renderedMarkdown = renderReviewedReportMarkdown(
      bundle.incident.title,
      statements,
    );
    const canonicalRequest = JSON.stringify({
      incidentId: command.incidentId,
      reportDraftId: command.reportDraftId,
      expectedIncidentVersion: command.expectedIncidentVersion,
      acknowledgedContradictions: command.acknowledgedContradictions,
      acknowledgedOpenQuestions: command.acknowledgedOpenQuestions,
      decisions: [...command.decisions].sort((left, right) =>
        left.statementId.localeCompare(right.statementId),
      ),
    });
    return this.reviews.createRevision({
      id: this.idGenerator.generate(),
      reviewer: input.reviewer,
      incidentId: command.incidentId,
      reportDraftId: command.reportDraftId,
      expectedIncidentVersion: command.expectedIncidentVersion,
      clientRequestId: command.clientRequestId,
      requestSha256: sha256(canonicalRequest),
      acknowledgedContradictions: command.acknowledgedContradictions,
      acknowledgedOpenQuestions: command.acknowledgedOpenQuestions,
      statements,
      renderedMarkdown,
      contentSha256: sha256(renderedMarkdown),
      createdAt: this.clock.now(),
      auditEventId: this.idGenerator.generate(),
    });
  }
}

export class ApproveReportRevision {
  public constructor(
    private readonly reviews: IncidentReviewRepository,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  public execute(input: {
    readonly reviewer: ReviewerIdentity;
    readonly command: unknown;
  }): Promise<ReportRevision> {
    const command = approveReportRevisionCommandSchema.parse(input.command);
    return this.reviews.approveRevision({
      approvalId: this.idGenerator.generate(),
      auditEventId: this.idGenerator.generate(),
      reviewer: input.reviewer,
      incidentId: command.incidentId,
      revisionId: command.revisionId,
      expectedIncidentVersion: command.expectedIncidentVersion,
      clientRequestId: command.clientRequestId,
      approvedAt: this.clock.now(),
    });
  }
}

function resolveStatement(
  id: string,
  source: IncidentReviewBundle['sections'][number]['statements'][number],
  decision: ReturnType<
    typeof createReportRevisionCommandSchema.parse
  >['decisions'][number],
): ResolvedReviewStatement {
  if (decision.decision === 'EXCLUDE') {
    return {
      id,
      originalStatementId: source.id,
      sectionType: source.sectionType,
      position: source.position,
      decision: 'EXCLUDE',
      text: null,
      classification: null,
      claimIds: source.claimIds,
      timelineEventIds: source.timelineEventIds,
    };
  }
  if (decision.decision === 'KEEP') {
    return {
      id,
      originalStatementId: source.id,
      sectionType: source.sectionType,
      position: source.position,
      decision: 'KEEP',
      text: source.text,
      classification: source.classification,
      claimIds: source.claimIds,
      timelineEventIds: source.timelineEventIds,
    };
  }
  const classification = decision.classification;
  const text = decision.text;
  if (classification === undefined || text === undefined) {
    throw new ReviewValidationError('Edited statement content is incomplete');
  }
  if (
    classification !== 'human_confirmed' &&
    classificationCaution(classification) <
      classificationCaution(source.classification)
  ) {
    throw new ReviewValidationError(
      'An edit cannot silently strengthen source certainty; use human confirmed',
    );
  }
  return {
    id,
    originalStatementId: source.id,
    sectionType: source.sectionType,
    position: source.position,
    decision: 'EDIT',
    text,
    classification,
    claimIds: source.claimIds,
    timelineEventIds: source.timelineEventIds,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
