import { createHash } from 'node:crypto';
import type { Clock } from './ports/clock.js';
import type { IdGenerator } from './ports/id-generator.js';
import type { IncidentReviewRepository } from './ports/incident-review-repository.js';
import {
  approveReportRevisionCommandSchema,
  assignIncidentReviewerCommandSchema,
  classificationCaution,
  createReportRevisionCommandSchema,
  ReviewAuthorizationError,
  ReviewConflictError,
  ReviewNotFoundError,
  ReviewValidationError,
  type IncidentReviewBundle,
  type IncidentReviewerAssignment,
  type ReportRevision,
  type ReportRevisionDetail,
  type ResolvedReviewQuestionAnswer,
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

export class AssignIncidentReviewer {
  public constructor(
    private readonly reviews: IncidentReviewRepository,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  public async execute(input: {
    readonly reviewer: ReviewerIdentity;
    readonly incidentId: string;
    readonly command: unknown;
  }): Promise<IncidentReviewerAssignment> {
    const command = assignIncidentReviewerCommandSchema.parse(input.command);
    return this.reviews.assignReviewer({
      auditEventId: this.idGenerator.generate(),
      reviewer: input.reviewer,
      incidentId: input.incidentId,
      expectedIncidentVersion: command.expectedIncidentVersion,
      memberSubject: command.memberSubject,
      clientRequestId: command.clientRequestId,
      assignedAt: this.clock.now(),
    });
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
    if (sourceStatements.length + command.additionalStatements.length > 300) {
      throw new ReviewValidationError(
        'A report revision cannot contain more than 300 statements',
      );
    }
    if (sourceStatements.length !== command.decisions.length) {
      throw new ReviewValidationError(
        'Every report statement requires exactly one review decision',
      );
    }
    const sources = new Map(
      sourceStatements.map((statement) => [statement.id, statement]),
    );
    const reviewedStatements = command.decisions.map((decision) => {
      const source = sources.get(decision.statementId);
      if (source === undefined) {
        throw new ReviewValidationError(
          'Review decision references an unknown report statement',
        );
      }
      return resolveStatement(this.idGenerator.generate(), source, decision);
    });
    const claims = new Map(bundle.claims.map((claim) => [claim.id, claim]));
    const timeline = new Map(bundle.timeline.map((event) => [event.id, event]));
    const nextPosition = new Map(
      bundle.sections.map((section) => [
        section.sectionType,
        Math.max(
          -1,
          ...section.statements.map((statement) => statement.position),
        ) + 1,
      ]),
    );
    const additionalStatements = command.additionalStatements.map(
      (statement): ResolvedReviewStatement => {
        const sourceClassifications = [
          ...statement.claimIds.map((claimId) => {
            const claim = claims.get(claimId);
            if (claim === undefined) {
              throw new ReviewValidationError(
                'Reviewer statement references an unknown claim',
              );
            }
            return claim.classification;
          }),
          ...statement.timelineEventIds.map((eventId) => {
            const event = timeline.get(eventId);
            if (event === undefined) {
              throw new ReviewValidationError(
                'Reviewer statement references an unknown timeline event',
              );
            }
            return event.classification;
          }),
        ];
        const requiredCaution = Math.max(
          ...sourceClassifications.map(classificationCaution),
        );
        if (classificationCaution(statement.classification) < requiredCaution) {
          throw new ReviewValidationError(
            'Reviewer statement is more certain than its linked evidence',
          );
        }
        const position = nextPosition.get(statement.sectionType) ?? 0;
        if (position >= 100) {
          throw new ReviewValidationError(
            'A report section cannot contain more than 100 statements',
          );
        }
        nextPosition.set(statement.sectionType, position + 1);
        return {
          id: this.idGenerator.generate(),
          originalStatementId: null,
          sectionType: statement.sectionType,
          position,
          decision: 'ADD',
          text: statement.text,
          classification: statement.classification,
          claimIds: statement.claimIds,
          timelineEventIds: statement.timelineEventIds,
        };
      },
    );
    const statements = [...reviewedStatements, ...additionalStatements];
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

    const questions = new Map(
      bundle.openQuestions.map((question) => [question.id, question]),
    );
    const questionAnswers: ResolvedReviewQuestionAnswer[] =
      command.questionAnswers.map((answer) => {
        const question = questions.get(answer.questionId);
        if (question === undefined) {
          throw new ReviewValidationError(
            'Review answer references an unknown open question',
          );
        }
        return {
          id: this.idGenerator.generate(),
          questionId: question.id,
          question: question.question,
          answer: answer.answer,
        };
      });

    const renderedMarkdown = renderReviewedReportMarkdown(
      bundle.incident.title,
      statements,
      questionAnswers,
      bundle.openQuestions,
    );
    const canonicalRequest = JSON.stringify({
      incidentId: command.incidentId,
      reportDraftId: command.reportDraftId,
      expectedIncidentVersion: command.expectedIncidentVersion,
      acknowledgedContradictions: command.acknowledgedContradictions,
      acknowledgedOpenQuestions: command.acknowledgedOpenQuestions,
      questionAnswers: [...command.questionAnswers].sort((left, right) =>
        left.questionId.localeCompare(right.questionId),
      ),
      additionalStatements: [...command.additionalStatements].sort(
        (left, right) =>
          left.clientStatementId.localeCompare(right.clientStatementId),
      ),
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
      questionAnswers,
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
