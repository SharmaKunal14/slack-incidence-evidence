import {
  INCIDENT_REPORT_SECTION_TYPES,
  type IncidentReportSectionType,
} from '../report/incident-report.js';
import type { ResolvedReviewStatement } from './incident-review.js';

const HEADINGS: Readonly<Record<IncidentReportSectionType, string>> = {
  executive_summary: 'Executive summary',
  impact: 'Impact',
  detection: 'Detection',
  timeline: 'Timeline',
  root_cause: 'Root cause',
  contributing_factors: 'Contributing factors',
  mitigation_and_recovery: 'Mitigation and recovery',
  what_went_well: 'What went well',
  what_did_not_go_well: 'What did not go well',
  follow_up_recommendations: 'Follow-up recommendations',
};

export function renderReviewedReportMarkdown(
  incidentTitle: string,
  statements: readonly ResolvedReviewStatement[],
): string {
  const lines = [
    `# ${escapeMarkdown(incidentTitle)}`,
    '',
    '> Human-reviewed incident report revision. Publication is a separate controlled action.',
    '',
  ];
  for (const sectionType of INCIDENT_REPORT_SECTION_TYPES) {
    lines.push(`## ${HEADINGS[sectionType]}`, '');
    const included = statements
      .filter(
        (statement) =>
          statement.sectionType === sectionType &&
          statement.decision !== 'EXCLUDE',
      )
      .sort((left, right) => left.position - right.position);
    if (included.length === 0) {
      lines.push('_No reviewed information is included._', '');
      continue;
    }
    for (const statement of included) {
      const references =
        statement.claimIds.length > 0
          ? `claims: ${statement.claimIds.map(escapeMarkdown).join(', ')}`
          : `timeline events: ${statement.timelineEventIds
              .map(escapeMarkdown)
              .join(', ')}`;
      lines.push(
        `- ${classificationPrefix(statement.classification)}${escapeMarkdown(statement.text ?? '')}`,
        `  - _Sources: ${references}_`,
      );
    }
    lines.push('');
  }
  const markdown = `${lines.join('\n').trim()}\n`;
  if (markdown.length > 200_000) {
    throw new Error('Reviewed report exceeds the size limit');
  }
  return markdown;
}

function classificationPrefix(
  classification: ResolvedReviewStatement['classification'],
): string {
  switch (classification) {
    case 'human_confirmed':
      return '**Human confirmed:** ';
    case 'hypothesis':
      return '**Hypothesis:** ';
    case 'correlated_inference':
      return '**Correlated inference:** ';
    case 'participant_assertion':
      return '**Participant assertion:** ';
    case 'disputed':
      return '**Disputed:** ';
    case 'unknown':
      return '**Unknown:** ';
    case 'directly_observed':
    case 'corroborated':
      return '';
    case null:
      return '';
  }
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\\`*_{}[\]<>#|]/gu, '\\$&');
}
