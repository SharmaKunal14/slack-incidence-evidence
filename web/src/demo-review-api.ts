import { z } from 'zod';
import type { ReviewApiClient } from './app.js';
import { ApiError } from './auth.js';
import {
  bundleSchema,
  classificationValues,
  inboxSchema,
  type Bundle,
  type Configuration,
  type InboxItem,
  type RevisionDetail,
} from './contracts.js';

export const demoIncidentId = '10420000-0000-4000-8000-000000000001';
const reportDraftId = '10420000-0000-4000-8000-000000000002';
const revisionId = '10420000-0000-4000-8000-000000000003';
const demoToken = 'synthetic-demo';

export const demoConfiguration: Configuration = {
  apiBaseUrl: 'https://demo.invalid/',
  cognitoBaseUrl: 'https://auth.demo.invalid/',
  cognitoClientId: 'synthetic-demo',
  redirectUri: 'https://demo.invalid/',
};

const decisionSchema = z.discriminatedUnion('decision', [
  z.object({ statementId: z.string(), decision: z.literal('KEEP') }).strict(),
  z
    .object({ statementId: z.string(), decision: z.literal('EXCLUDE') })
    .strict(),
  z
    .object({
      statementId: z.string(),
      decision: z.literal('EDIT'),
      text: z.string().trim().min(1).max(8_000),
      classification: z.enum(classificationValues),
    })
    .strict(),
]);

const additionalStatementSchema = z
  .object({
    clientStatementId: z.uuid(),
    sectionType: z.string().min(1).max(100),
    text: z.string().trim().min(1).max(8_000),
    classification: z.enum(classificationValues),
    claimIds: z.array(z.string()).max(20),
    timelineEventIds: z.array(z.string()).max(20),
  })
  .strict()
  .refine(
    (statement) =>
      statement.claimIds.length > 0 || statement.timelineEventIds.length > 0,
    'A reviewer-added statement must cite at least one source',
  );

const createRevisionSchema = z
  .object({
    incidentId: z.literal(demoIncidentId),
    reportDraftId: z.literal(reportDraftId),
    expectedIncidentVersion: z.number().int().nonnegative(),
    clientRequestId: z.uuid(),
    acknowledgedContradictions: z.boolean(),
    acknowledgedOpenQuestions: z.boolean(),
    questionAnswers: z
      .array(
        z
          .object({
            questionId: z.string(),
            answer: z.string().trim().min(1).max(4_000),
          })
          .strict(),
      )
      .max(100),
    additionalStatements: z.array(additionalStatementSchema).max(100),
    decisions: z.array(decisionSchema).max(300),
  })
  .strict();

const approveRevisionSchema = z
  .object({
    incidentId: z.literal(demoIncidentId),
    revisionId: z.literal(revisionId),
    expectedIncidentVersion: z.number().int().nonnegative(),
    clientRequestId: z.uuid(),
  })
  .strict();

export function createDemoReviewApi(): ReviewApiClient {
  let bundle = initialBundle();
  const completedRequests = new Map<
    string,
    { readonly body: string; readonly response: unknown }
  >();

  return async (_configuration, token, path, init = {}) => {
    await Promise.resolve();
    if (token !== demoToken) throw new ApiError(401);

    const url = new URL(path, demoConfiguration.apiBaseUrl);
    const method = init.method?.toUpperCase() ?? 'GET';
    if (url.origin !== new URL(demoConfiguration.apiBaseUrl).origin) {
      throw new ApiError(400);
    }

    if (method === 'GET' && url.pathname === '/review/incidents') {
      return inboxSchema.parse({
        items: [inboxItem(bundle)],
        nextCursor: null,
      });
    }

    if (
      method === 'GET' &&
      url.pathname === `/review/incidents/${demoIncidentId}`
    ) {
      return clone(bundle);
    }

    if (
      method === 'POST' &&
      url.pathname === `/review/incidents/${demoIncidentId}/revisions`
    ) {
      const body = serializedBody(init.body);
      const request = createRevisionSchema.parse(parseBody(body));
      const replay = replayResponse(
        completedRequests,
        request.clientRequestId,
        body,
      );
      if (replay.found) return replay.response;
      if (request.expectedIncidentVersion !== bundle.incident.version) {
        throw new ApiError(409);
      }
      assertCompleteDecisions(bundle, request.decisions);

      const createdAt = '2026-07-22T09:45:00.000Z';
      const questionById = new Map(
        bundle.openQuestions.map((question) => [question.id, question]),
      );
      const sourceStatements = bundle.sections.flatMap(
        (section) => section.statements,
      );
      const statementById = new Map(
        sourceStatements.map((statement) => [statement.id, statement]),
      );
      const revisionStatements: RevisionDetail['statements'] = [
        ...request.decisions.map((decision) => {
          const source = statementById.get(decision.statementId);
          if (source === undefined) throw new ApiError(400);
          return {
            originalStatementId: source.id,
            sectionType: source.sectionType,
            position: source.position,
            decision: decision.decision,
            text:
              decision.decision === 'EXCLUDE'
                ? null
                : decision.decision === 'EDIT'
                  ? decision.text
                  : source.text,
            classification:
              decision.decision === 'EXCLUDE'
                ? null
                : decision.decision === 'EDIT'
                  ? decision.classification
                  : source.classification,
            claimIds: source.claimIds,
            timelineEventIds: source.timelineEventIds,
          };
        }),
        ...request.additionalStatements.map((statement, index) => ({
          originalStatementId: null,
          sectionType: statement.sectionType,
          position: 100 + index,
          decision: 'ADD' as const,
          text: statement.text,
          classification: statement.classification,
          claimIds: statement.claimIds,
          timelineEventIds: statement.timelineEventIds,
        })),
      ];
      const questionAnswers = request.questionAnswers.map((answer) => {
        const question = questionById.get(answer.questionId);
        if (question === undefined) throw new ApiError(400);
        return { ...answer, question: question.question };
      });
      const latestRevision: RevisionDetail = {
        id: revisionId,
        revisionNumber: 1,
        status: 'DRAFT',
        createdAt,
        statementCount: revisionStatements.length,
        acknowledgedContradictions: request.acknowledgedContradictions,
        acknowledgedOpenQuestions: request.acknowledgedOpenQuestions,
        statements: revisionStatements,
        questionAnswers,
      };
      bundle = bundleSchema.parse({
        ...bundle,
        incident: {
          ...bundle.incident,
          version: bundle.incident.version + 1,
          updatedAt: createdAt,
        },
        revisions: [revisionSummary(latestRevision)],
        latestRevision,
      });
      const response = { revision: revisionSummary(latestRevision) };
      completedRequests.set(request.clientRequestId, { body, response });
      return clone(response);
    }

    if (
      method === 'POST' &&
      url.pathname ===
        `/review/incidents/${demoIncidentId}/revisions/${revisionId}/approve`
    ) {
      const body = serializedBody(init.body);
      const request = approveRevisionSchema.parse(parseBody(body));
      const replay = replayResponse(
        completedRequests,
        request.clientRequestId,
        body,
      );
      if (replay.found) return replay.response;
      if (
        request.expectedIncidentVersion !== bundle.incident.version ||
        bundle.latestRevision?.status !== 'DRAFT'
      ) {
        throw new ApiError(409);
      }
      const updatedAt = '2026-07-22T09:48:00.000Z';
      const latestRevision = {
        ...bundle.latestRevision,
        status: 'APPROVED' as const,
      };
      bundle = bundleSchema.parse({
        ...bundle,
        incident: {
          ...bundle.incident,
          status: 'APPROVED',
          version: bundle.incident.version + 1,
          updatedAt,
        },
        revisions: [revisionSummary(latestRevision)],
        latestRevision,
      });
      const response = { revision: revisionSummary(latestRevision) };
      completedRequests.set(request.clientRequestId, { body, response });
      return clone(response);
    }

    throw new ApiError(404);
  };
}

function initialBundle(): Bundle {
  return bundleSchema.parse({
    incident: {
      id: demoIncidentId,
      title: 'EU checkout outage',
      severity: 'SEV-1',
      status: 'NEEDS_REVIEW',
      version: 7,
      createdAt: '2026-07-22T08:58:00.000Z',
      updatedAt: '2026-07-22T09:38:00.000Z',
    },
    reportDraft: {
      id: reportDraftId,
      draftVersion: 1,
      renderedMarkdown: '# EU checkout outage',
    },
    sections: [
      {
        sectionType: 'root_cause',
        position: 0,
        statements: [
          {
            id: 'statement-root-cause',
            sectionType: 'root_cause',
            position: 0,
            statementType: 'claim',
            text: 'An unauthorized WAF rule blocked browser checkout requests before they reached the application.',
            classification: 'directly_observed',
            claimIds: ['claim-waf-rule'],
            timelineEventIds: ['timeline-rule-change'],
          },
        ],
      },
      {
        sectionType: 'contributing_factors',
        position: 1,
        statements: [
          {
            id: 'statement-access',
            sectionType: 'contributing_factors',
            position: 0,
            statementType: 'claim',
            text: 'A contractor role inherited production edge-policy access through a broader operations group.',
            classification: 'participant_assertion',
            claimIds: ['claim-access'],
            timelineEventIds: [],
          },
        ],
      },
      {
        sectionType: 'ruled_out_hypotheses',
        position: 2,
        statements: [
          {
            id: 'statement-deployment',
            sectionType: 'ruled_out_hypotheses',
            position: 0,
            statementType: 'claim',
            text: 'The checkout deployment was correlated with the outage window but did not cause the failed requests.',
            classification: 'corroborated',
            claimIds: ['claim-deployment'],
            timelineEventIds: ['timeline-deploy'],
          },
        ],
      },
      {
        sectionType: 'recovery',
        position: 3,
        statements: [
          {
            id: 'statement-recovery',
            sectionType: 'recovery',
            position: 0,
            statementType: 'timeline',
            text: 'Checkout recovered after the rule was disabled and edge-generated 403 responses returned to baseline.',
            classification: 'corroborated',
            claimIds: ['claim-recovery'],
            timelineEventIds: ['timeline-recovery'],
          },
        ],
      },
    ],
    claims: [
      {
        id: 'claim-waf-rule',
        statement: 'A WAF rule blocked checkout traffic at the edge.',
        classification: 'directly_observed',
        reviewStatus: 'unreviewed',
        supportingEvidenceIds: ['evidence-audit', 'evidence-rule'],
        contradictingEvidenceIds: [],
      },
      {
        id: 'claim-access',
        statement: 'The contractor role inherited production policy access.',
        classification: 'participant_assertion',
        reviewStatus: 'unreviewed',
        supportingEvidenceIds: ['evidence-access'],
        contradictingEvidenceIds: [],
      },
      {
        id: 'claim-deployment',
        statement: 'The checkout deployment caused the outage.',
        classification: 'disputed',
        reviewStatus: 'unreviewed',
        supportingEvidenceIds: ['evidence-deploy'],
        contradictingEvidenceIds: ['evidence-routing'],
      },
      {
        id: 'claim-recovery',
        statement: 'Disabling the WAF rule restored checkout.',
        classification: 'corroborated',
        reviewStatus: 'unreviewed',
        supportingEvidenceIds: ['evidence-disabled', 'evidence-recovery'],
        contradictingEvidenceIds: [],
      },
    ],
    timeline: [
      {
        id: 'timeline-deploy',
        occurredAt: '2026-07-22T08:55:00.000Z',
        summary: 'checkout-api deployment completed.',
        classification: 'directly_observed',
        evidenceIds: ['evidence-deploy'],
      },
      {
        id: 'timeline-rule-change',
        occurredAt: '2026-07-22T08:57:42.000Z',
        summary: 'An unapproved production WAF rule was created.',
        classification: 'directly_observed',
        evidenceIds: ['evidence-audit'],
      },
      {
        id: 'timeline-recovery',
        occurredAt: '2026-07-22T09:32:00.000Z',
        summary: 'Edge-generated 403 responses returned to baseline.',
        classification: 'corroborated',
        evidenceIds: ['evidence-disabled', 'evidence-recovery'],
      },
    ],
    evidence: [
      evidence(
        'evidence-deploy',
        '2026-07-22T09:06:00.000Z',
        'Maya Chen',
        'checkout-api completed deployment at 08:55. The timing is suspicious, but failed requests may not be reaching the application.',
      ),
      evidence(
        'evidence-audit',
        '2026-07-22T09:08:00.000Z',
        'Arjun Rao',
        'Audit history shows a production WAF policy change at 08:57:42. There is no approved change ticket attached.',
      ),
      evidence(
        'evidence-routing',
        '2026-07-22T09:11:00.000Z',
        'Maya Chen',
        'Most failed requests never reached checkout-api. That weakens the deployment hypothesis.',
      ),
      evidence(
        'evidence-rule',
        '2026-07-22T09:14:00.000Z',
        'Arjun Rao',
        'The changed rule matches a common browser header and blocks the request before it reaches the application.',
      ),
      evidence(
        'evidence-access',
        '2026-07-22T09:17:00.000Z',
        'Arjun Rao',
        'The contractor role inherited that permission through a broader operations group.',
      ),
      evidence(
        'evidence-disabled',
        '2026-07-22T09:27:14.000Z',
        'Arjun Rao',
        'Unauthorized rule disabled. No other WAF rules changed.',
      ),
      evidence(
        'evidence-recovery',
        '2026-07-22T09:32:00.000Z',
        'Maya Chen',
        'Edge-generated 403 rate returned to baseline. No new suspicious policy activity detected.',
      ),
    ],
    evidenceCoverage: [
      coverage('channel-incident', '#incident-checkout', 28),
      coverage('channel-deployments', '#deployments', 16),
      coverage('channel-security', '#security-alerts', 11),
    ],
    openQuestions: [
      {
        id: 'question-session',
        question: 'How was the authenticated contractor session acquired?',
        evidenceIds: ['evidence-audit', 'evidence-access'],
      },
    ],
    revisions: [],
    latestRevision: null,
  });
}

function evidence(
  id: string,
  occurredAt: string,
  authorReference: string,
  content: string,
): Bundle['evidence'][number] {
  return {
    id,
    sourceType: 'slack_message',
    occurredAt,
    authorReference,
    content,
    contentTruncated: false,
    sourceUri: null,
  };
}

function coverage(
  sourceId: string,
  sourceName: string,
  messageCount: number,
): Bundle['evidenceCoverage'][number] {
  return {
    sourceId,
    provider: 'slack',
    sourceName,
    state: 'COLLECTED',
    messageCount,
    permissionOutcome: 'AUTHORIZED',
    reason: null,
  };
}

function inboxItem(bundle: Bundle): InboxItem {
  const contradictionCount = bundle.claims.filter(
    (claim) =>
      claim.classification === 'disputed' ||
      claim.contradictingEvidenceIds.length > 0,
  ).length;
  return {
    incidentId: bundle.incident.id,
    title: bundle.incident.title,
    severity: bundle.incident.severity,
    status: bundle.incident.status,
    createdAt: bundle.incident.createdAt,
    updatedAt: bundle.incident.updatedAt,
    incidentVersion: bundle.incident.version,
    reportDraftId: bundle.reportDraft.id,
    claimCount: bundle.claims.length,
    timelineEventCount: bundle.timeline.length,
    openQuestionCount: bundle.openQuestions.length,
    contradictionCount,
    latestRevisionId: bundle.latestRevision?.id ?? null,
    latestRevisionNumber: bundle.latestRevision?.revisionNumber ?? null,
    latestRevisionStatus: bundle.latestRevision?.status ?? null,
  };
}

function revisionSummary(
  revision: RevisionDetail,
): Bundle['revisions'][number] {
  return {
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    status: revision.status,
    createdAt: revision.createdAt,
    statementCount: revision.statementCount,
    acknowledgedContradictions: revision.acknowledgedContradictions,
    acknowledgedOpenQuestions: revision.acknowledgedOpenQuestions,
  };
}

function serializedBody(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string' || body.length > 512_000) {
    throw new ApiError(400);
  }
  return body;
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiError(400);
  }
}

function replayResponse(
  completedRequests: ReadonlyMap<
    string,
    { readonly body: string; readonly response: unknown }
  >,
  clientRequestId: string,
  body: string,
):
  | { readonly found: false }
  | { readonly found: true; readonly response: unknown } {
  const completed = completedRequests.get(clientRequestId);
  if (completed === undefined) return { found: false };
  if (completed.body !== body) throw new ApiError(409);
  return { found: true, response: clone(completed.response) };
}

function assertCompleteDecisions(
  bundle: Bundle,
  decisions: readonly z.infer<typeof decisionSchema>[],
): void {
  const expectedIds = new Set(
    bundle.sections.flatMap((section) =>
      section.statements.map((statement) => statement.id),
    ),
  );
  const actualIds = new Set(decisions.map((decision) => decision.statementId));
  if (
    actualIds.size !== decisions.length ||
    actualIds.size !== expectedIds.size ||
    [...expectedIds].some((id) => !actualIds.has(id))
  ) {
    throw new ApiError(400);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
