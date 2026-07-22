import { z } from 'zod';
import {
  MODEL_EVIDENCE_CLASSIFICATIONS,
  type IncidentAnalysis,
} from '../analysis/incident-analysis.js';

export const INCIDENT_REPORT_SECTION_TYPES = [
  'executive_summary',
  'impact',
  'detection',
  'timeline',
  'root_cause',
  'contributing_factors',
  'mitigation_and_recovery',
  'what_went_well',
  'what_did_not_go_well',
  'follow_up_recommendations',
] as const;

export type IncidentReportSectionType =
  (typeof INCIDENT_REPORT_SECTION_TYPES)[number];
export type ModelEvidenceClassification =
  IncidentAnalysis['claims'][number]['classification'];

const sectionTypeSchema = z.enum(INCIDENT_REPORT_SECTION_TYPES);
const classificationSchema = z.enum(MODEL_EVIDENCE_CLASSIFICATIONS);
const modelKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .max(64);
const sourceIdSchema = z.string().min(1).max(128);

const reportStatementSchema = z
  .object({
    key: modelKeySchema,
    statementType: z.enum(['claim', 'timeline']),
    text: z.string().trim().min(1).max(4_000),
    classification: classificationSchema,
    claimIds: z.array(sourceIdSchema).max(20),
    timelineEventIds: z.array(sourceIdSchema).max(20),
  })
  .strict()
  .superRefine((statement, context) => {
    requireUnique(statement.claimIds, 'claim ID', context, ['claimIds']);
    requireUnique(statement.timelineEventIds, 'timeline event ID', context, [
      'timelineEventIds',
    ]);
    const validClaim =
      statement.statementType === 'claim' &&
      statement.claimIds.length > 0 &&
      statement.timelineEventIds.length === 0;
    const validTimeline =
      statement.statementType === 'timeline' &&
      statement.timelineEventIds.length > 0 &&
      statement.claimIds.length === 0;
    if (!validClaim && !validTimeline) {
      context.addIssue({
        code: 'custom',
        message: 'A statement must reference exactly one source type',
      });
    }
  });

const reportSchema = z
  .object({
    sections: z
      .array(
        z
          .object({
            sectionType: sectionTypeSchema,
            statements: z.array(reportStatementSchema).max(30),
          })
          .strict(),
      )
      .length(INCIDENT_REPORT_SECTION_TYPES.length),
  })
  .strict()
  .superRefine((report, context) => {
    requireUnique(
      report.sections.map((section) => section.sectionType),
      'section type',
      context,
      ['sections'],
    );
    requireUnique(
      report.sections.flatMap((section) =>
        section.statements.map((statement) => statement.key),
      ),
      'statement key',
      context,
      ['sections'],
    );
    const present = new Set(
      report.sections.map((section) => section.sectionType),
    );
    for (const sectionType of INCIDENT_REPORT_SECTION_TYPES) {
      if (!present.has(sectionType)) {
        context.addIssue({
          code: 'custom',
          message: `Missing report section: ${sectionType}`,
          path: ['sections'],
        });
      }
    }
    for (const [sectionIndex, section] of report.sections.entries()) {
      for (const [statementIndex, statement] of section.statements.entries()) {
        if (containsUnsafeReportText(statement.text)) {
          context.addIssue({
            code: 'custom',
            message: 'Report text contains a URL, HTML, or secret-like token',
            path: [
              'sections',
              sectionIndex,
              'statements',
              statementIndex,
              'text',
            ],
          });
        }
      }
    }
  });

export type IncidentReport = z.infer<typeof reportSchema>;

export interface ReportClaimSource {
  readonly id: string;
  readonly statement: string;
  readonly classification: ModelEvidenceClassification;
  readonly supportingEvidenceCount: number;
  readonly contradictingEvidenceCount: number;
}

export interface ReportTimelineSource {
  readonly id: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly classification: ModelEvidenceClassification;
  readonly evidenceCount: number;
}

export interface ReportOpenQuestionSource {
  readonly id: string;
  readonly question: string;
  readonly evidenceIds: readonly string[];
}

export interface IncidentReportManifest {
  readonly incidentTitle: string;
  readonly analysisRunId: string;
  readonly claims: readonly ReportClaimSource[];
  readonly timeline: readonly ReportTimelineSource[];
  readonly openQuestions: readonly ReportOpenQuestionSource[];
  readonly coverage?: readonly {
    readonly sourceId: string;
    readonly sourceName: string;
    readonly state: string;
    readonly messageCount: number;
    readonly reason: string | null;
  }[];
}

export class InvalidReportSourceReferenceError extends Error {
  public constructor(sourceType: string, reference: string) {
    super(`Report references unknown ${sourceType}: ${reference}`);
    this.name = 'InvalidReportSourceReferenceError';
  }
}

export class ReportClassificationOverstatementError extends Error {
  public constructor() {
    super('Report statement is more certain than its supporting source');
    this.name = 'ReportClassificationOverstatementError';
  }
}

/**
 * Validates provider structure, tenant-scoped source references, and that the
 * writer cannot upgrade uncertain extraction into a stronger factual claim.
 */
export function parseIncidentReport(
  value: unknown,
  manifest: IncidentReportManifest,
): IncidentReport {
  const report = reportSchema.parse(value);
  const claims = new Map(manifest.claims.map((claim) => [claim.id, claim]));
  const timeline = new Map(manifest.timeline.map((event) => [event.id, event]));
  const usedClaims = new Set<string>();
  const usedTimelineEvents = new Set<string>();

  for (const section of report.sections) {
    for (const statement of section.statements) {
      const sourceClassifications: ModelEvidenceClassification[] = [];
      for (const claimId of statement.claimIds) {
        const claim = claims.get(claimId);
        if (claim === undefined) {
          throw new InvalidReportSourceReferenceError('claim', claimId);
        }
        usedClaims.add(claimId);
        sourceClassifications.push(claim.classification);
      }
      for (const eventId of statement.timelineEventIds) {
        const event = timeline.get(eventId);
        if (event === undefined) {
          throw new InvalidReportSourceReferenceError(
            'timeline event',
            eventId,
          );
        }
        sourceClassifications.push(event.classification);
        usedTimelineEvents.add(eventId);
      }
      const requiredCaution = Math.max(
        ...sourceClassifications.map(classificationCaution),
      );
      if (classificationCaution(statement.classification) < requiredCaution) {
        throw new ReportClassificationOverstatementError();
      }
    }
  }

  for (const claim of manifest.claims) {
    if (
      (claim.classification === 'disputed' ||
        claim.contradictingEvidenceCount > 0) &&
      !usedClaims.has(claim.id)
    ) {
      throw new Error('Report omits a claim with material contradiction');
    }
  }
  for (const claim of manifest.claims) {
    if (
      requiresReportCoverage(claim.classification) &&
      !usedClaims.has(claim.id)
    ) {
      throw new Error('Report omits a sufficiently supported claim');
    }
  }
  for (const event of manifest.timeline) {
    if (
      requiresReportCoverage(event.classification) &&
      !usedTimelineEvents.has(event.id)
    ) {
      throw new Error('Report omits a sufficiently supported timeline event');
    }
  }
  return report;
}

function requiresReportCoverage(
  classification: ModelEvidenceClassification,
): boolean {
  return (
    classification === 'directly_observed' ||
    classification === 'corroborated' ||
    classification === 'participant_assertion'
  );
}

/** Strict Structured Outputs schema; application validation remains authoritative. */
export const INCIDENT_REPORT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sections'],
  properties: {
    sections: {
      type: 'array',
      minItems: INCIDENT_REPORT_SECTION_TYPES.length,
      maxItems: INCIDENT_REPORT_SECTION_TYPES.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sectionType', 'statements'],
        properties: {
          sectionType: {
            type: 'string',
            enum: INCIDENT_REPORT_SECTION_TYPES,
          },
          statements: {
            type: 'array',
            maxItems: 30,
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'key',
                'statementType',
                'text',
                'classification',
                'claimIds',
                'timelineEventIds',
              ],
              properties: {
                key: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
                statementType: {
                  type: 'string',
                  enum: ['claim', 'timeline'],
                },
                text: { type: 'string' },
                classification: {
                  type: 'string',
                  enum: MODEL_EVIDENCE_CLASSIFICATIONS,
                },
                claimIds: {
                  type: 'array',
                  maxItems: 20,
                  items: { type: 'string' },
                },
                timelineEventIds: {
                  type: 'array',
                  maxItems: 20,
                  items: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

function classificationCaution(
  classification: ModelEvidenceClassification,
): number {
  switch (classification) {
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

function containsUnsafeReportText(value: string): boolean {
  return (
    /(?:https?:\/\/|www\.)/iu.test(value) ||
    /<\/?[A-Za-z][^>]*>/u.test(value) ||
    /\b(?:xox[baprs]-|sk-(?:proj|live|test)-)[A-Za-z0-9_-]{8,}\b/u.test(value)
  );
}

function requireUnique(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: 'custom',
      message: `Duplicate ${label}`,
      path: [...path],
    });
  }
}
