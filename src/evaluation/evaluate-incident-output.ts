import type { IncidentAnalysis } from '../application/analysis/incident-analysis.js';
import type { IncidentReport } from '../application/report/incident-report.js';
import type { IncidentEvaluationFixture } from './contracts.js';

export interface IncidentEvaluationResult {
  readonly fixtureId: string;
  readonly expectedEvidenceGroups: number;
  readonly coveredEvidenceGroups: number;
  readonly expectedContradictions: number;
  readonly coveredContradictions: number;
  readonly causalOverstatementCount: number;
  readonly unsupportedClaimCount: number;
  readonly forbiddenOutputTermCount: number;
  readonly timelineOrderingCorrect: boolean;
  readonly reportStatementCount: number;
  readonly reportSourceCoverage: number;
}

/** Computes deterministic, explicitly named metrics without claiming semantics. */
export function evaluateIncidentOutput(
  fixture: IncidentEvaluationFixture,
  analysis: IncidentAnalysis,
  report: IncidentReport,
): IncidentEvaluationResult {
  let coveredEvidenceGroups = 0;
  let expectedContradictions = 0;
  let coveredContradictions = 0;
  let causalOverstatementCount = 0;

  for (const expected of fixture.expected.evidenceGroups) {
    const matchingClaim = analysis.claims.find(
      (claim) =>
        includesAll(
          claim.supportingEvidenceIds,
          expected.supportingEvidenceIds,
        ) &&
        includesAll(
          claim.contradictingEvidenceIds,
          expected.contradictingEvidenceIds,
        ),
    );
    if (matchingClaim !== undefined) {
      coveredEvidenceGroups += 1;
      if (
        caution(matchingClaim.classification) < caution(expected.minimumCaution)
      ) {
        causalOverstatementCount += 1;
      }
    }
    if (expected.contradictingEvidenceIds.length > 0) {
      expectedContradictions += 1;
      if (matchingClaim !== undefined) {
        coveredContradictions += 1;
      }
    }
  }

  const serializedOutput = JSON.stringify({ analysis, report }).toLowerCase();
  const forbiddenOutputTermCount = fixture.expected.forbiddenOutputTerms.filter(
    (term) => serializedOutput.includes(term.toLowerCase()),
  ).length;
  const reportStatements = report.sections.flatMap(
    (section) => section.statements,
  );
  const sourcedStatements = reportStatements.filter(
    (statement) =>
      statement.claimIds.length + statement.timelineEventIds.length > 0,
  ).length;

  return {
    fixtureId: fixture.fixtureId,
    expectedEvidenceGroups: fixture.expected.evidenceGroups.length,
    coveredEvidenceGroups,
    expectedContradictions,
    coveredContradictions,
    causalOverstatementCount,
    unsupportedClaimCount: analysis.claims.filter(
      (claim) =>
        !['hypothesis', 'unknown'].includes(claim.classification) &&
        claim.supportingEvidenceIds.length === 0,
    ).length,
    forbiddenOutputTermCount,
    timelineOrderingCorrect: timelineOrderingIsCorrect(
      analysis,
      fixture.expected.timelineEvidenceOrder,
    ),
    reportStatementCount: reportStatements.length,
    reportSourceCoverage:
      reportStatements.length === 0
        ? 1
        : sourcedStatements / reportStatements.length,
  };
}

function timelineOrderingIsCorrect(
  analysis: IncidentAnalysis,
  evidenceOrder: readonly string[],
): boolean {
  let lastIndex = -1;
  for (const evidenceId of evidenceOrder) {
    const index = analysis.timeline.findIndex((event) =>
      event.evidenceIds.includes(evidenceId),
    );
    if (index < 0 || index < lastIndex) {
      return false;
    }
    lastIndex = index;
  }
  return true;
}

function includesAll(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const values = new Set(actual);
  return expected.every((value) => values.has(value));
}

function caution(
  classification: IncidentAnalysis['claims'][number]['classification'],
): number {
  switch (classification) {
    case 'directly_observed':
    case 'corroborated':
      return 0;
    case 'participant_assertion':
      return 1;
    case 'correlated_inference':
      return 2;
    case 'hypothesis':
      return 3;
    case 'disputed':
      return 4;
    case 'unknown':
      return 5;
  }
}
