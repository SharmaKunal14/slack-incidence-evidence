import {
  INCIDENT_REPORT_SECTION_TYPES,
  type IncidentReport,
  type IncidentReportManifest,
  type IncidentReportSectionType,
  type ModelEvidenceClassification,
} from './incident-report.js';

const SECTION_HEADINGS: Readonly<Record<IncidentReportSectionType, string>> = {
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

const MAX_RENDERED_MARKDOWN_CHARACTERS = 200_000;

/** Renders validated structured content; the model never controls Markdown. */
export function renderIncidentReportMarkdown(
  report: IncidentReport,
  manifest: IncidentReportManifest,
): string {
  const sectionMap = new Map(
    report.sections.map((section) => [section.sectionType, section]),
  );
  const lines = [
    `# ${escapeMarkdown(manifest.incidentTitle)}`,
    '',
    '> AI-generated draft. Human review is required before publication.',
    '',
  ];

  for (const sectionType of INCIDENT_REPORT_SECTION_TYPES) {
    const section = sectionMap.get(sectionType);
    lines.push(`## ${SECTION_HEADINGS[sectionType]}`, '');
    if (section === undefined || section.statements.length === 0) {
      lines.push('_No supported information is available._', '');
      continue;
    }
    for (const statement of section.statements) {
      const references =
        statement.statementType === 'claim'
          ? `claims: ${statement.claimIds.map(escapeMarkdown).join(', ')}`
          : `timeline events: ${statement.timelineEventIds.map(escapeMarkdown).join(', ')}`;
      lines.push(
        `- ${classificationPrefix(statement.classification)}${escapeMarkdown(normalizeWhitespace(statement.text))}`,
        `  - _Sources: ${references}_`,
      );
    }
    lines.push('');
  }

  lines.push('## Open questions', '');
  if (manifest.openQuestions.length === 0) {
    lines.push('_No open questions were extracted._', '');
  } else {
    for (const question of manifest.openQuestions) {
      lines.push(
        `- ${escapeMarkdown(normalizeWhitespace(question.question))}`,
        `  - _Question reference: ${escapeMarkdown(question.id)}_`,
      );
    }
    lines.push('');
  }

  const markdown = `${lines.join('\n').trim()}\n`;
  if (markdown.length > MAX_RENDERED_MARKDOWN_CHARACTERS) {
    throw new Error('Rendered incident report exceeds the size limit');
  }
  return markdown;
}

function classificationPrefix(
  classification: ModelEvidenceClassification,
): string {
  switch (classification) {
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
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]<>#|]/gu, '\\$&');
}
