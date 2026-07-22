import { describe, expect, it } from 'vitest';
import {
  INCIDENT_ANALYSIS_JSON_SCHEMA,
  InvalidEvidenceReferenceError,
  parseIncidentAnalysis,
} from '../../src/application/analysis/incident-analysis.js';

const analysis = {
  timeline: [
    {
      key: 'event_1',
      occurredAt: '2026-07-17T01:00:00.000Z',
      summary: 'Deployment v4.18 was rolled back.',
      classification: 'directly_observed',
      evidenceIds: ['github-deployment-1'],
    },
  ],
  claims: [
    {
      key: 'claim_1',
      statement: 'Deployment v4.18 was rolled back.',
      classification: 'directly_observed',
      supportingEvidenceIds: ['github-deployment-1'],
      contradictingEvidenceIds: [],
    },
  ],
  openQuestions: [
    {
      key: 'rollback_recovery_unknown',
      question: 'Did the rollback restore service?',
      evidenceIds: ['github-deployment-1'],
    },
  ],
};

describe('parseIncidentAnalysis', () => {
  it('uses only provider-supported constraints in the strict JSON schema', () => {
    const serialized = JSON.stringify(INCIDENT_ANALYSIS_JSON_SCHEMA);
    expect(serialized).not.toContain('minLength');
    expect(serialized).not.toContain('maxLength');
    expect(serialized).toContain('maxItems');
    expect(serialized).toContain('additionalProperties');
  });

  it('accepts structured analysis backed by available evidence', () => {
    expect(
      parseIncidentAnalysis(analysis, new Set(['github-deployment-1'])),
    ).toEqual(analysis);
  });

  it('rejects model output that invents an evidence reference', () => {
    expect(() => parseIncidentAnalysis(analysis, new Set())).toThrow(
      InvalidEvidenceReferenceError,
    );
  });

  it('rejects classifications reserved for human review', () => {
    expect(() =>
      parseIncidentAnalysis(
        {
          ...analysis,
          claims: [
            {
              ...analysis.claims[0],
              classification: 'human_confirmed',
            },
          ],
        },
        new Set(['github-deployment-1']),
      ),
    ).toThrow();
  });

  it('requires support for non-hypothetical claims', () => {
    expect(() =>
      parseIncidentAnalysis(
        {
          ...analysis,
          claims: [
            {
              ...analysis.claims[0],
              supportingEvidenceIds: [],
            },
          ],
        },
        new Set(['github-deployment-1']),
      ),
    ).toThrow();
  });
});
