import { z } from 'zod';

const evidenceClassificationSchema = z.enum([
  'directly_observed',
  'corroborated',
  'participant_assertion',
  'hypothesis',
  'correlated_inference',
  'disputed',
  'unknown',
  'human_confirmed',
]);

const analysisSchema = z
  .object({
    timeline: z.array(
      z
        .object({
          id: z.string().min(1),
          occurredAt: z.iso.datetime(),
          summary: z.string().trim().min(1),
          evidenceIds: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
    claims: z.array(
      z
        .object({
          id: z.string().min(1),
          statement: z.string().trim().min(1),
          classification: evidenceClassificationSchema,
          supportingEvidenceIds: z.array(z.string().min(1)),
          contradictingEvidenceIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    openQuestions: z.array(z.string().trim().min(1)),
  })
  .strict();

export type IncidentAnalysis = z.infer<typeof analysisSchema>;

export class InvalidEvidenceReferenceError extends Error {
  public constructor(reference: string) {
    super(`Analysis references unknown evidence: ${reference}`);
    this.name = 'InvalidEvidenceReferenceError';
  }
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
  ];

  for (const reference of references) {
    if (!availableEvidenceIds.has(reference)) {
      throw new InvalidEvidenceReferenceError(reference);
    }
  }

  return analysis;
}
