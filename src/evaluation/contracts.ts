import { z } from 'zod';
import { MODEL_EVIDENCE_CLASSIFICATIONS } from '../application/analysis/incident-analysis.js';

const evidenceSchema = z
  .object({
    id: z.string().min(1).max(128),
    sourceType: z.string().min(1).max(64),
    occurredAt: z.iso.datetime(),
    authorReference: z.string().min(1).max(64).nullable(),
    content: z.string().min(1).max(10_000),
  })
  .strict();

const expectedEvidenceGroupSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    supportingEvidenceIds: z.array(z.string().min(1).max(128)).min(1).max(20),
    contradictingEvidenceIds: z.array(z.string().min(1).max(128)).max(20),
    minimumCaution: z.enum(MODEL_EVIDENCE_CLASSIFICATIONS),
  })
  .strict();

const fixtureSchema = z
  .object({
    fixtureId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    incidentTitle: z.string().trim().min(1).max(500),
    evidence: z.array(evidenceSchema).min(1).max(100),
    expected: z
      .object({
        evidenceGroups: z.array(expectedEvidenceGroupSchema).max(100),
        timelineEvidenceOrder: z.array(z.string().min(1).max(128)).max(100),
        forbiddenOutputTerms: z.array(z.string().min(1).max(200)).max(50),
      })
      .strict(),
    recordedAnalysis: z.unknown(),
  })
  .strict()
  .superRefine((fixture, context) => {
    const evidenceIds = new Set(fixture.evidence.map((item) => item.id));
    if (evidenceIds.size !== fixture.evidence.length) {
      context.addIssue({ code: 'custom', message: 'Duplicate evidence ID' });
    }
    const expectedIds = [
      ...fixture.expected.timelineEvidenceOrder,
      ...fixture.expected.evidenceGroups.flatMap((group) => [
        ...group.supportingEvidenceIds,
        ...group.contradictingEvidenceIds,
      ]),
    ];
    if (expectedIds.some((id) => !evidenceIds.has(id))) {
      context.addIssue({
        code: 'custom',
        message: 'Fixture expectation references unknown evidence',
      });
    }
  });

const fixtureFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    fixtures: z.array(fixtureSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.fixtures.map((fixture) => fixture.fixtureId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Duplicate fixture ID' });
    }
  });

export type IncidentEvaluationFixture = z.infer<typeof fixtureSchema>;

export function parseEvaluationFixtureFile(
  value: unknown,
): readonly IncidentEvaluationFixture[] {
  return fixtureFileSchema.parse(value).fixtures;
}
