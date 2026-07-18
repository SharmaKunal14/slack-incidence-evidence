import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  parseIncidentAnalysis,
  type IncidentAnalysis,
} from '../application/analysis/incident-analysis.js';
import type { IncidentAnalyzer } from '../application/ports/incident-analyzer.js';
import type { IncidentReportGenerator } from '../application/ports/incident-report-generator.js';
import {
  INCIDENT_REPORT_SECTION_TYPES,
  parseIncidentReport,
  type IncidentReport,
  type IncidentReportManifest,
} from '../application/report/incident-report.js';
import { loadLiveEvaluationEnvironment } from '../config/environment.js';
import { SecretsManagerSecretReader } from '../infrastructure/secrets/secrets-manager-secret-reader.js';
import {
  parseEvaluationFixtureFile,
  type IncidentEvaluationFixture,
} from './contracts.js';
import {
  evaluateIncidentOutput,
  type IncidentEvaluationResult,
} from './evaluate-incident-output.js';
import {
  createLiveEvaluationProviders,
  type LiveEvaluationProviders,
} from './live-evaluation-providers.js';

const FIXTURE_FILE = fileURLToPath(
  new URL('../../evals/fixtures/v1.json', import.meta.url),
);

type EvaluationMode = 'offline' | 'live';

interface EvaluatedFixture {
  readonly result: IncidentEvaluationResult;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMilliseconds: number;
}

interface EvaluationSummary {
  readonly deterministicSafetyFailures: number;
  readonly [key: string]: unknown;
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv[2]);
  const fixtures = await loadFixtures();
  const providers = mode === 'live' ? await liveProviders() : null;
  const evaluated: EvaluatedFixture[] = [];
  const failures: { readonly fixtureId: string; readonly code: string }[] = [];

  for (const fixture of fixtures) {
    const startedAt = Date.now();
    try {
      const outcome =
        providers === null
          ? offlineOutcome(fixture)
          : await liveOutcome(fixture, providers.analyzer, providers.generator);
      evaluated.push({
        result: evaluateIncidentOutput(
          fixture,
          outcome.analysis,
          outcome.report,
        ),
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        latencyMilliseconds: Date.now() - startedAt,
      });
    } catch (error) {
      failures.push({
        fixtureId: fixture.fixtureId,
        code: safeErrorCode(error),
      });
    }
  }

  const summary = summarize(mode, fixtures.length, evaluated, failures);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failures.length > 0 || summary.deterministicSafetyFailures > 0) {
    process.exitCode = 1;
  }
}

async function loadFixtures(): Promise<readonly IncidentEvaluationFixture[]> {
  const body = await readFile(FIXTURE_FILE, 'utf8');
  return parseEvaluationFixtureFile(JSON.parse(body) as unknown);
}

function offlineOutcome(fixture: IncidentEvaluationFixture): {
  readonly analysis: IncidentAnalysis;
  readonly report: IncidentReport;
  readonly inputTokens: 0;
  readonly outputTokens: 0;
} {
  const analysis = parseIncidentAnalysis(
    fixture.recordedAnalysis,
    new Set(fixture.evidence.map((evidence) => evidence.id)),
  );
  const manifest = reportManifest(fixture, analysis);
  const report = parseIncidentReport(referenceReport(manifest), manifest);
  return { analysis, report, inputTokens: 0, outputTokens: 0 };
}

async function liveOutcome(
  fixture: IncidentEvaluationFixture,
  analyzer: IncidentAnalyzer,
  generator: IncidentReportGenerator,
): Promise<{
  readonly analysis: IncidentAnalysis;
  readonly report: IncidentReport;
  readonly inputTokens: number;
  readonly outputTokens: number;
}> {
  const analysisResult = await analyzer.analyze({
    manifest: {
      incidentTitle: fixture.incidentTitle,
      evidence: fixture.evidence,
    },
    availableEvidenceIds: new Set(
      fixture.evidence.map((evidence) => evidence.id),
    ),
    clientRequestId: randomUUID(),
  });
  const manifest = reportManifest(fixture, analysisResult.analysis);
  const reportResult = await generator.generate({
    manifest,
    clientRequestId: randomUUID(),
  });
  return {
    analysis: analysisResult.analysis,
    report: reportResult.report,
    inputTokens:
      analysisResult.usage.inputTokens + reportResult.usage.inputTokens,
    outputTokens:
      analysisResult.usage.outputTokens + reportResult.usage.outputTokens,
  };
}

function reportManifest(
  fixture: IncidentEvaluationFixture,
  analysis: IncidentAnalysis,
): IncidentReportManifest {
  return {
    incidentTitle: fixture.incidentTitle,
    analysisRunId: `evaluation-${fixture.fixtureId}`,
    claims: analysis.claims.map((claim) => ({
      id: `claim_${claim.key}`,
      statement: claim.statement,
      classification: claim.classification,
      supportingEvidenceCount: claim.supportingEvidenceIds.length,
      contradictingEvidenceCount: claim.contradictingEvidenceIds.length,
    })),
    timeline: analysis.timeline.map((event) => ({
      id: `timeline_${event.key}`,
      occurredAt: event.occurredAt,
      summary: event.summary,
      classification: event.classification,
      evidenceCount: event.evidenceIds.length,
    })),
    openQuestions: analysis.openQuestions.map((question, index) => ({
      id: `question_${index + 1}`,
      question,
    })),
  };
}

function referenceReport(manifest: IncidentReportManifest): IncidentReport {
  return {
    sections: INCIDENT_REPORT_SECTION_TYPES.map((sectionType) => ({
      sectionType,
      statements:
        sectionType === 'executive_summary'
          ? manifest.claims.map((claim, index) => ({
              key: `claim_statement_${index + 1}`,
              statementType: 'claim' as const,
              text: claim.statement,
              classification: claim.classification,
              claimIds: [claim.id],
              timelineEventIds: [],
            }))
          : sectionType === 'timeline'
            ? manifest.timeline.map((event, index) => ({
                key: `timeline_statement_${index + 1}`,
                statementType: 'timeline' as const,
                text: event.summary,
                classification: event.classification,
                claimIds: [],
                timelineEventIds: [event.id],
              }))
            : [],
    })),
  };
}

async function liveProviders(): Promise<LiveEvaluationProviders> {
  const environment = loadLiveEvaluationEnvironment();
  const secrets = new SecretsManagerClient({ region: environment.AWS_REGION });
  try {
    return await createLiveEvaluationProviders(
      environment,
      new SecretsManagerSecretReader(secrets),
    );
  } finally {
    secrets.destroy();
  }
}

function summarize(
  mode: EvaluationMode,
  fixtureCount: number,
  evaluated: readonly EvaluatedFixture[],
  failures: readonly { readonly fixtureId: string; readonly code: string }[],
): EvaluationSummary {
  const results = evaluated.map((item) => item.result);
  const expectedGroups = sum(results, 'expectedEvidenceGroups');
  const coveredGroups = sum(results, 'coveredEvidenceGroups');
  const expectedContradictions = sum(results, 'expectedContradictions');
  const coveredContradictions = sum(results, 'coveredContradictions');
  const deterministicSafetyFailures =
    Math.max(0, expectedGroups - coveredGroups) +
    Math.max(0, expectedContradictions - coveredContradictions) +
    sum(results, 'causalOverstatementCount') +
    sum(results, 'unsupportedClaimCount') +
    sum(results, 'forbiddenOutputTermCount') +
    results.filter((result) => !result.timelineOrderingCorrect).length +
    results.filter((result) => result.reportSourceCoverage < 1).length;
  return {
    schemaVersion: 1,
    mode,
    fixtureCount,
    completedFixtureCount: evaluated.length,
    failedFixtureCount: failures.length,
    failures,
    metrics: {
      expectedEvidenceGroupCoverage:
        expectedGroups === 0 ? 1 : coveredGroups / expectedGroups,
      contradictionRecall:
        expectedContradictions === 0
          ? 1
          : coveredContradictions / expectedContradictions,
      timelineOrderingPassRate:
        results.length === 0
          ? 0
          : results.filter((result) => result.timelineOrderingCorrect).length /
            results.length,
      reportSourceCoverage:
        results.length === 0
          ? 0
          : results.reduce(
              (total, result) => total + result.reportSourceCoverage,
              0,
            ) / results.length,
      causalOverstatementCount: sum(results, 'causalOverstatementCount'),
      unsupportedClaimCount: sum(results, 'unsupportedClaimCount'),
      forbiddenOutputTermCount: sum(results, 'forbiddenOutputTermCount'),
      inputTokens: evaluated.reduce(
        (total, item) => total + item.inputTokens,
        0,
      ),
      outputTokens: evaluated.reduce(
        (total, item) => total + item.outputTokens,
        0,
      ),
      averageLatencyMilliseconds:
        evaluated.length === 0
          ? 0
          : Math.round(
              evaluated.reduce(
                (total, item) => total + item.latencyMilliseconds,
                0,
              ) / evaluated.length,
            ),
    },
    deterministicSafetyFailures,
    qualification:
      'Evidence-group coverage is structural and does not establish semantic accuracy or factual entailment.',
  };
}

function sum(
  results: readonly IncidentEvaluationResult[],
  key:
    | 'expectedEvidenceGroups'
    | 'coveredEvidenceGroups'
    | 'expectedContradictions'
    | 'coveredContradictions'
    | 'causalOverstatementCount'
    | 'unsupportedClaimCount'
    | 'forbiddenOutputTermCount',
): number {
  return results.reduce((total, result) => total + result[key], 0);
}

function parseMode(value: string | undefined): EvaluationMode {
  if (value === 'offline' || value === 'live') {
    return value;
  }
  throw new Error('Evaluation mode must be offline or live');
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { readonly code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) {
      return code;
    }
    return error.name
      .replace(/[^A-Za-z0-9_]/gu, '_')
      .toUpperCase()
      .slice(0, 64);
  }
  return 'UNKNOWN_ERROR';
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ error: safeErrorCode(error), message: 'Evaluation failed' })}\n`,
  );
  process.exitCode = 1;
});
