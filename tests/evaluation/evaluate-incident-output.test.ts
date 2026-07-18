import { describe, expect, it } from 'vitest';
import { parseIncidentAnalysis } from '../../src/application/analysis/incident-analysis.js';
import {
  INCIDENT_REPORT_SECTION_TYPES,
  parseIncidentReport,
  type IncidentReportManifest,
} from '../../src/application/report/incident-report.js';
import { parseEvaluationFixtureFile } from '../../src/evaluation/contracts.js';
import { evaluateIncidentOutput } from '../../src/evaluation/evaluate-incident-output.js';

describe('AI evaluation metrics', () => {
  it('measures structural coverage without labelling it semantic accuracy', () => {
    const [fixture] = parseEvaluationFixtureFile({
      schemaVersion: 1,
      fixtures: [
        {
          fixtureId: 'metric-fixture',
          incidentTitle: 'Metric fixture',
          evidence: [
            {
              id: 'evidence-1',
              sourceType: 'SLACK_MESSAGE',
              occurredAt: '2026-07-18T01:00:00.000Z',
              authorReference: 'participant_1',
              content: 'Errors were reported.',
            },
          ],
          expected: {
            evidenceGroups: [
              {
                key: 'errors',
                supportingEvidenceIds: ['evidence-1'],
                contradictingEvidenceIds: [],
                minimumCaution: 'participant_assertion',
              },
            ],
            timelineEvidenceOrder: ['evidence-1'],
            forbiddenOutputTerms: ['synthetic-secret'],
          },
          recordedAnalysis: {},
        },
      ],
    });
    if (fixture === undefined) {
      throw new Error('Expected fixture');
    }
    const analysis = parseIncidentAnalysis(
      {
        timeline: [
          {
            key: 'errors_reported',
            occurredAt: '2026-07-18T01:00:00.000Z',
            summary: 'Errors were reported.',
            classification: 'participant_assertion',
            evidenceIds: ['evidence-1'],
          },
        ],
        claims: [
          {
            key: 'errors_claim',
            statement: 'Errors were reported.',
            classification: 'participant_assertion',
            supportingEvidenceIds: ['evidence-1'],
            contradictingEvidenceIds: [],
          },
        ],
        openQuestions: [],
      },
      new Set(['evidence-1']),
    );
    const manifest: IncidentReportManifest = {
      incidentTitle: fixture.incidentTitle,
      analysisRunId: 'analysis-1',
      claims: [
        {
          id: 'claim-1',
          statement: 'Errors were reported.',
          classification: 'participant_assertion',
          supportingEvidenceCount: 1,
          contradictingEvidenceCount: 0,
        },
      ],
      timeline: [],
      openQuestions: [],
    };
    const report = parseIncidentReport(
      {
        sections: INCIDENT_REPORT_SECTION_TYPES.map((sectionType) => ({
          sectionType,
          statements:
            sectionType === 'executive_summary'
              ? [
                  {
                    key: 'errors_statement',
                    statementType: 'claim',
                    text: 'Errors were reported.',
                    classification: 'participant_assertion',
                    claimIds: ['claim-1'],
                    timelineEventIds: [],
                  },
                ]
              : [],
        })),
      },
      manifest,
    );

    expect(evaluateIncidentOutput(fixture, analysis, report)).toMatchObject({
      coveredEvidenceGroups: 1,
      causalOverstatementCount: 0,
      unsupportedClaimCount: 0,
      forbiddenOutputTermCount: 0,
      timelineOrderingCorrect: true,
      reportSourceCoverage: 1,
    });
  });
});
