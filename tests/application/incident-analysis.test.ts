import { describe, expect, it } from 'vitest';
import {
  InvalidEvidenceReferenceError,
  parseIncidentAnalysis,
} from '../../src/application/analysis/incident-analysis.js';

const analysis = {
  timeline: [
    {
      id: 'event-1',
      occurredAt: '2026-07-17T01:00:00.000Z',
      summary: 'Deployment v4.18 was rolled back.',
      evidenceIds: ['github-deployment-1'],
    },
  ],
  claims: [
    {
      id: 'claim-1',
      statement: 'Deployment v4.18 was rolled back.',
      classification: 'directly_observed',
      supportingEvidenceIds: ['github-deployment-1'],
      contradictingEvidenceIds: [],
    },
  ],
  openQuestions: ['Did the rollback restore service?'],
};

describe('parseIncidentAnalysis', () => {
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
});
