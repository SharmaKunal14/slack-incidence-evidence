import { describe, expect, it } from 'vitest';
import {
  INCIDENT_REPORT_SECTION_TYPES,
  InvalidReportSourceReferenceError,
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
  openQuestions: [
    {
      id: 'question-1',
      question: 'What changed?',
      evidenceIds: ['evidence-1'],
    },
  ],
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

  it('states partial evidence coverage explicitly in deterministic Markdown', () => {
    const markdown = renderIncidentReportMarkdown(validReport(), {
      ...manifest,
      coverage: [
        {
          sourceId: 'source-1',
          sourceName: '#incident-checkout',
          state: 'COMPLETE',
          messageCount: 46,
          reason: 'WINDOW_COLLECTED',
        },
        {
          sourceId: 'source-2',
          sourceName: '#database-alerts',
          state: 'INACCESSIBLE',
          messageCount: 0,
          reason: 'SLACK_NO_PERMISSION',
        },
      ],
    });

    expect(markdown).toContain('## Evidence coverage');
    expect(markdown).toContain('Evidence coverage is partial');
    expect(markdown).toContain('#database-alerts** — Access unavailable');
  });

  it('rejects fabricated source references', () => {
    const report = validReport();
    report.sections[0]!.statements[0]!.claimIds = ['fabricated-claim'];

    expect(() => parseIncidentReport(report, manifest)).toThrow(
      InvalidReportSourceReferenceError,
    );
  });

  it('downgrades model metadata that overstates a cited source', () => {
    const report = validReport();
    const statement = report.sections[0]!.statements[0]!;
    statement.classification = 'directly_observed';

    const parsed = parseIncidentReport(report, manifest);
    expect(parsed.sections[0]!.statements[0]).toMatchObject({
      text: statement.text,
      classification: 'correlated_inference',
    });
  });

  it('rejects omission of a materially contradicted claim', () => {
    const report = validReport();
    report.sections[0]!.statements.splice(1, 1);

    expect(() => parseIncidentReport(report, manifest)).toThrow(
      'Report omits a claim with material contradiction',
    );
  });

  it('rejects omission of sufficiently supported evidence', () => {
    const supportedManifest: IncidentReportManifest = {
      ...manifest,
      claims: [
        ...manifest.claims,
        {
          id: 'claim-3',
          statement: 'Monitoring detected the first failure.',
          classification: 'corroborated',
          supportingEvidenceCount: 2,
          contradictingEvidenceCount: 0,
        },
      ],
    };

    expect(() => parseIncidentReport(validReport(), supportedManifest)).toThrow(
      'Report omits a sufficiently supported claim',
    );
  });

  it('rejects omission of a sufficiently supported timeline event', () => {
    const report = validReport();
    const timelineSection = report.sections.find(
      (section) => section.sectionType === 'timeline',
    );
    if (timelineSection === undefined) {
      throw new Error('Expected timeline section');
    }
    timelineSection.statements = [];

    expect(() => parseIncidentReport(report, manifest)).toThrow(
      'Report omits a sufficiently supported timeline event',
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
