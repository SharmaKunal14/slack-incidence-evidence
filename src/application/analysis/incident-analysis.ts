import { z } from 'zod';

export const MODEL_EVIDENCE_CLASSIFICATIONS = [
  'directly_observed',
  'corroborated',
  'participant_assertion',
  'hypothesis',
  'correlated_inference',
  'disputed',
  'unknown',
] as const;

const evidenceClassificationSchema = z.enum(MODEL_EVIDENCE_CLASSIFICATIONS);
const modelKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .max(64);
const evidenceIdSchema = z.string().min(1).max(128);

const analysisSchema = z
  .object({
    timeline: z
      .array(
        z
          .object({
            key: modelKeySchema,
            occurredAt: z.iso.datetime(),
            summary: z.string().trim().min(1).max(2_000),
            classification: evidenceClassificationSchema,
            evidenceIds: z.array(evidenceIdSchema).min(1).max(20),
          })
          .strict(),
      )
      .max(100),
    claims: z
      .array(
        z
          .object({
            key: modelKeySchema,
            statement: z.string().trim().min(1).max(4_000),
            classification: evidenceClassificationSchema,
            supportingEvidenceIds: z.array(evidenceIdSchema).max(20),
            contradictingEvidenceIds: z.array(evidenceIdSchema).max(20),
          })
          .strict(),
      )
      .max(100),
    openQuestions: z
      .array(
        z
          .object({
            key: modelKeySchema,
            question: z.string().trim().min(1).max(2_000),
            evidenceIds: z.array(evidenceIdSchema).min(1).max(20),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .superRefine((analysis, context) => {
    requireUnique(
      analysis.timeline.map((event) => event.key),
      'timeline key',
      context,
    );
    requireUnique(
      analysis.claims.map((claim) => claim.key),
      'claim key',
      context,
    );
    for (const [index, event] of analysis.timeline.entries()) {
      requireUnique(event.evidenceIds, 'timeline evidence ID', context, [
        'timeline',
        index,
        'evidenceIds',
      ]);
    }
    for (const [index, claim] of analysis.claims.entries()) {
      requireUnique(
        claim.supportingEvidenceIds,
        'supporting evidence ID',
        context,
        ['claims', index, 'supportingEvidenceIds'],
      );
      requireUnique(
        claim.contradictingEvidenceIds,
        'contradicting evidence ID',
        context,
        ['claims', index, 'contradictingEvidenceIds'],
      );
      const supporting = new Set(claim.supportingEvidenceIds);
      if (claim.contradictingEvidenceIds.some((id) => supporting.has(id))) {
        context.addIssue({
          code: 'custom',
          message: 'Evidence cannot both support and contradict one claim',
          path: ['claims', index],
        });
      }
      if (
        !['hypothesis', 'unknown'].includes(claim.classification) &&
        claim.supportingEvidenceIds.length === 0
      ) {
        context.addIssue({
          code: 'custom',
          message: 'A non-hypothetical claim requires supporting evidence',
          path: ['claims', index, 'supportingEvidenceIds'],
        });
      }
    }
    requireUnique(
      analysis.openQuestions.map((question) => question.key),
      'open question key',
      context,
      ['openQuestions'],
    );
    requireUnique(
      analysis.openQuestions.map((question) => question.question),
      'open question',
      context,
      ['openQuestions'],
    );
    for (const [index, question] of analysis.openQuestions.entries()) {
      requireUnique(
        question.evidenceIds,
        'open question evidence ID',
        context,
        ['openQuestions', index, 'evidenceIds'],
      );
    }
  });

export type IncidentAnalysis = z.infer<typeof analysisSchema>;

export class InvalidEvidenceReferenceError extends Error {
  public constructor(reference: string) {
    super(`Analysis references unknown evidence: ${reference}`);
    this.name = 'InvalidEvidenceReferenceError';
  }
}

/** Builds a strict provider schema whose citations are limited to this run's evidence. */
export function buildIncidentAnalysisJsonSchema(
  availableEvidenceIds: ReadonlySet<string>,
): typeof INCIDENT_ANALYSIS_JSON_SCHEMA & {
  readonly $defs: {
    readonly evidenceId: {
      readonly type: 'string';
      readonly enum: readonly string[];
    };
  };
} {
  const evidenceIds = [...availableEvidenceIds].sort();
  if (
    evidenceIds.length === 0 ||
    evidenceIds.length > 500 ||
    evidenceIds.some((id) => !evidenceIdSchema.safeParse(id).success)
  ) {
    throw new Error('Available evidence IDs cannot form a provider schema');
  }
  return {
    ...INCIDENT_ANALYSIS_JSON_SCHEMA,
    $defs: {
      evidenceId: {
        type: 'string',
        enum: evidenceIds,
      },
    },
  };
}

/** Validates model structure and the application-level citation invariant. */
export function parseIncidentAnalysis(
  value: unknown,
  availableEvidenceIds: ReadonlySet<string>,
): IncidentAnalysis {
  const analysis = analysisSchema.parse(value);
  const references = [
    ...analysis.timeline.flatMap((event) => event.evidenceIds),
    ...analysis.claims.flatMap((claim) => [
      ...claim.supportingEvidenceIds,
      ...claim.contradictingEvidenceIds,
    ]),
    ...analysis.openQuestions.flatMap((question) => question.evidenceIds),
  ];

  for (const reference of references) {
    if (!availableEvidenceIds.has(reference)) {
      throw new InvalidEvidenceReferenceError(reference);
    }
  }

  return analysis;
}

function requireUnique(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
  path: readonly PropertyKey[] = [],
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: 'custom',
      message: `Duplicate ${label}`,
      path: [...path],
    });
  }
}

/** Strict Structured Outputs schema; application validation remains authoritative. */
export const INCIDENT_ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  $defs: {
    evidenceId: {
      type: 'string',
    },
  },
  required: ['timeline', 'claims', 'openQuestions'],
  properties: {
    timeline: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'key',
          'occurredAt',
          'summary',
          'classification',
          'evidenceIds',
        ],
        properties: {
          key: {
            type: 'string',
            pattern: '^[a-z][a-z0-9_]{0,63}$',
          },
          occurredAt: { type: 'string', format: 'date-time' },
          summary: { type: 'string' },
          classification: {
            type: 'string',
            enum: MODEL_EVIDENCE_CLASSIFICATIONS,
          },
          evidenceIds: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { $ref: '#/$defs/evidenceId' },
          },
        },
      },
    },
    claims: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'key',
          'statement',
          'classification',
          'supportingEvidenceIds',
          'contradictingEvidenceIds',
        ],
        properties: {
          key: {
            type: 'string',
            pattern: '^[a-z][a-z0-9_]{0,63}$',
          },
          statement: { type: 'string' },
          classification: {
            type: 'string',
            enum: MODEL_EVIDENCE_CLASSIFICATIONS,
          },
          supportingEvidenceIds: {
            type: 'array',
            maxItems: 20,
            items: { $ref: '#/$defs/evidenceId' },
          },
          contradictingEvidenceIds: {
            type: 'array',
            maxItems: 20,
            items: { $ref: '#/$defs/evidenceId' },
          },
        },
      },
    },
    openQuestions: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'question', 'evidenceIds'],
        properties: {
          key: {
            type: 'string',
            pattern: '^[a-z][a-z0-9_]{0,63}$',
          },
          question: { type: 'string' },
          evidenceIds: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { $ref: '#/$defs/evidenceId' },
          },
        },
      },
    },
  },
} as const;
