import { describe, expect, it } from 'vitest';
import {
  INCIDENT_REPORT_SECTION_TYPES,
  InvalidReportSourceReferenceError,
  ReportClassificationOverstatementError,
  parseIncidentReport,
  type IncidentReport,
  type IncidentReportManifest,
} from '../../src/application/report/incident-report.js';
import { renderIncidentReportMarkdown } from '../../src/application/report/render-incident-report.js';

const manifest: IncidentReportManifest = {
  incidentTitle: 'Checkout *outage*',
  analysisRunId: 'analysis-1',
  claims: [
    {
      id: 'claim-1',
      statement: 'Recovery followed the rollback.',
      classification: 'correlated_inference',
      supportingEvidenceCount: 1,
      contradictingEvidenceCount: 0,
    },
    {
      id: 'claim-2',
      statement: 'The cache hypothesis is disputed.',
      classification: 'disputed',
      supportingEvidenceCount: 1,
      contradictingEvidenceCount: 1,
    },
  ],
  timeline: [
    {
      id: 'timeline-1',
      occurredAt: '2026-07-18T01:00:00.000Z',
      summary: 'Rollback completed.',
      classification: 'directly_observed',
      evidenceCount: 1,
    },
  ],
  openQuestions: [{ id: 'question-1', question: 'What changed?' }],
};

function validReport(): IncidentReport {
  return {
    sections: INCIDENT_REPORT_SECTION_TYPES.map((sectionType) => ({
      sectionType,
      statements:
        sectionType === 'executive_summary'
          ? [
              {
                key: 'recovery_followed_rollback',
                statementType: 'claim' as const,
                text: 'Recovery followed the rollback.',
                classification: 'correlated_inference' as const,
                claimIds: ['claim-1'],
                timelineEventIds: [],
              },
              {
                key: 'cache_hypothesis_disputed',
                statementType: 'claim' as const,
                text: 'The cache hypothesis remains disputed.',
                classification: 'disputed' as const,
                claimIds: ['claim-2'],
                timelineEventIds: [],
              },
            ]
          : sectionType === 'timeline'
            ? [
                {
                  key: 'rollback_completed',
                  statementType: 'timeline' as const,
                  text: 'Rollback completed.',
                  classification: 'directly_observed' as const,
                  claimIds: [],
                  timelineEventIds: ['timeline-1'],
                },
              ]
            : [],
    })),
  };
}

describe('incident report validation and rendering', () => {
  it('accepts a complete source-linked draft and renders trusted Markdown', () => {
    const report = parseIncidentReport(validReport(), manifest);
    const markdown = renderIncidentReportMarkdown(report, manifest);

    expect(markdown).toContain('# Checkout \\*outage\\*');
    expect(markdown).toContain('**Correlated inference:**');
    expect(markdown).toContain('_Sources: claims: claim-1_');
    expect(markdown).toContain('## Open questions');
    expect(markdown).toContain('Question reference: question-1');
    expect(markdown).toContain('Human review is required');
  });

  it('rejects fabricated source references', () => {
    const report = validReport();
    report.sections[0]!.statements[0]!.claimIds = ['fabricated-claim'];

    expect(() => parseIncidentReport(report, manifest)).toThrow(
      InvalidReportSourceReferenceError,
    );
  });

  it('rejects prose that upgrades a correlated inference to observation', () => {
    const report = validReport();
    report.sections[0]!.statements[0]!.classification = 'directly_observed';

    expect(() => parseIncidentReport(report, manifest)).toThrow(
      ReportClassificationOverstatementError,
    );
  });

  it('rejects omission of a materially contradicted claim', () => {
    const report = validReport();
    report.sections[0]!.statements.splice(1, 1);

    expect(() => parseIncidentReport(report, manifest)).toThrow(
      'Report omits a claim with material contradiction',
    );
  });

  it('rejects model-controlled links and HTML before rendering', () => {
    for (const unsafeText of [
      'See https://attacker.example/report',
      '<script>alert(1)</script>',
      'Token sk-test-synthetic12345678',
    ]) {
      const report = validReport();
      report.sections[0]!.statements[0]!.text = unsafeText;
      expect(() => parseIncidentReport(report, manifest)).toThrow();
    }
  });
});
