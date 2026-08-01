import { createHash } from 'node:crypto';
import type { Clock } from './ports/clock.js';
import type { IdGenerator } from './ports/id-generator.js';
import {
  IncidentReportConfigurationError,
  type IncidentReportDraft,
  type IncidentReportRepository,
} from './ports/incident-report-repository.js';
import {
  IncidentReportGeneratorError,
  type IncidentReportGenerator,
} from './ports/incident-report-generator.js';
import type { IncidentRepository } from './ports/incident-repository.js';
import {
  IncidentDeidentificationError,
  type IncidentDeidentifier,
} from './ports/incident-deidentifier.js';
import type { IncidentReport } from './report/incident-report.js';
import { renderIncidentReportMarkdown } from './report/render-incident-report.js';
import { IncidentAggregate, type Incident } from '../domain/incident.js';

const DRAFT_VERSION = 3;
const PROVIDER = 'openai';
const PROMPT_VERSION = 'incident-report-deidentified-v3';
const SCHEMA_VERSION = 'incident-report-v2';
const MAX_WORKFLOW_WAIT_SECONDS = 900;

export interface GenerateIncidentReportCommand {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly analysisRunId: string;
}

export type GenerateIncidentReportOutcome =
  | {
      readonly status: 'NEEDS_REVIEW';
      readonly reportDraftId: string;
      readonly sectionCount: number;
      readonly statementCount: number;
      readonly openQuestionCount: number;
    }
  | {
      readonly status: 'RETRY_WAIT';
      readonly retryAfterSeconds: number;
    }
  | {
      readonly status: 'FAILED';
      readonly reportDraftId: string;
      readonly failureCode: string;
    };

export interface GenerateIncidentReportConfiguration {
  readonly model: string;
  readonly maxSources: number;
  readonly maxInputCharacters: number;
  readonly maxAttempts: number;
  readonly leaseSeconds: number;
}

/** Coordinates a leased, source-linked and human-review-gated report draft. */
export class GenerateIncidentReport {
  public constructor(
    private readonly reports: IncidentReportRepository,
    private readonly incidents: IncidentRepository,
    private readonly generator: IncidentReportGenerator,
    private readonly deidentifier: IncidentDeidentifier,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly configuration: GenerateIncidentReportConfiguration,
  ) {
    validateConfiguration(configuration);
  }

  public async execute(
    input: GenerateIncidentReportCommand,
  ): Promise<GenerateIncidentReportOutcome> {
    const manifest = await this.reports.loadManifest(
      input.tenantId,
      input.incidentId,
      input.analysisRunId,
      this.configuration.maxSources + 1,
    );
    const sourceCount = manifest.claims.length + manifest.timeline.length;
    if (sourceCount === 0) {
      throw new IncidentReportConfigurationError(
        'A completed analysis has no reportable claims or timeline events',
      );
    }
    if (sourceCount > this.configuration.maxSources) {
      throw new IncidentReportConfigurationError(
        'Incident report sources exceed the configured limit',
      );
    }

    const serializedManifest = JSON.stringify(manifest);
    if (serializedManifest.length > this.configuration.maxInputCharacters) {
      throw new IncidentReportConfigurationError(
        'Incident report manifest exceeds the configured character limit',
      );
    }

    const incidentCanRun = await this.requireGeneratableIncident(
      input.tenantId,
      input.incidentId,
    );
    const now = this.clock.now();
    const leaseToken = this.idGenerator.generate();
    const acquired = await this.reports.acquire({
      id: this.idGenerator.generate(),
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      analysisRunId: input.analysisRunId,
      draftVersion: DRAFT_VERSION,
      inputManifestSha256: createHash('sha256')
        .update(serializedManifest, 'utf8')
        .digest('hex'),
      provider: PROVIDER,
      model: this.configuration.model,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      clientRequestId: this.idGenerator.generate(),
      inputClaimCount: manifest.claims.length,
      inputTimelineEventCount: manifest.timeline.length,
      inputOpenQuestionCount: manifest.openQuestions.length,
      inputCharacters: serializedManifest.length,
      maxAttempts: this.configuration.maxAttempts,
      leaseToken,
      now,
      leaseExpiresAt: new Date(
        now.getTime() + this.configuration.leaseSeconds * 1_000,
      ),
    });

    if (!incidentCanRun) {
      if (acquired.outcome === 'WAIT') {
        return retryOutcome(acquired.retryAfterSeconds);
      }
      if (acquired.outcome === 'NEEDS_REVIEW') {
        return reviewOutcome(acquired.draft, manifest.openQuestions.length);
      }
      if (acquired.outcome === 'FAILED') {
        return failedOutcome(acquired.draft);
      }
      const failed = await this.reports.fail({
        draft: acquired.draft,
        leaseToken,
        failureCode: 'INCIDENT_ALREADY_FAILED',
        failedAt: this.clock.now(),
      });
      return failedOutcome(failed);
    }

    if (acquired.outcome === 'WAIT') {
      return retryOutcome(acquired.retryAfterSeconds);
    }
    if (acquired.outcome === 'NEEDS_REVIEW') {
      await this.advanceToReview(acquired.draft);
      return reviewOutcome(acquired.draft, manifest.openQuestions.length);
    }
    if (acquired.outcome === 'FAILED') {
      await this.advanceToFailure(acquired.draft);
      return failedOutcome(acquired.draft);
    }

    const draft = acquired.draft;
    try {
      const deidentifiedManifest = await deidentifyReportManifest(
        manifest,
        this.deidentifier,
      );
      const result = await this.generator.generate({
        manifest: deidentifiedManifest,
        clientRequestId: draft.clientRequestId,
      });
      await this.deidentifier.assertSafe({
        texts: reportText(result.report),
      });
      const renderedMarkdown = renderIncidentReportMarkdown(
        result.report,
        deidentifiedManifest,
      );
      const completed = await this.reports.complete({
        draft,
        leaseToken,
        report: result.report,
        renderedMarkdown,
        providerResponseId: result.providerResponseId,
        providerModel: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        completedAt: this.clock.now(),
      });
      await this.advanceToReview(completed);
      return reviewOutcome(completed, manifest.openQuestions.length);
    } catch (error) {
      if (
        !(error instanceof IncidentReportGeneratorError) &&
        !(error instanceof IncidentDeidentificationError)
      ) {
        throw error;
      }
      if (error.retryable && draft.attemptCount < draft.maxAttempts) {
        const retryAfterSeconds = boundWait(
          (error instanceof IncidentReportGeneratorError
            ? error.retryAfterSeconds
            : null) ?? 2 ** draft.attemptCount,
        );
        const nowAfterFailure = this.clock.now();
        await this.reports.scheduleRetry({
          draft,
          leaseToken,
          failureCode: error.code,
          availableAt: new Date(
            nowAfterFailure.getTime() + retryAfterSeconds * 1_000,
          ),
          now: nowAfterFailure,
        });
        return { status: 'RETRY_WAIT', retryAfterSeconds };
      }

      const failed = await this.reports.fail({
        draft,
        leaseToken,
        failureCode: error.code,
        failedAt: this.clock.now(),
      });
      await this.advanceToFailure(failed);
      return failedOutcome(failed);
    }
  }

  private async requireGeneratableIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<boolean> {
    const incident = await this.requireIncident(tenantId, incidentId);
    if (incident.status === 'FAILED') {
      return false;
    }
    if (
      incident.status !== 'GENERATING' &&
      incident.status !== 'VERIFYING' &&
      incident.status !== 'NEEDS_REVIEW'
    ) {
      throw new IncidentReportConfigurationError(
        `Incident status ${incident.status} cannot generate a report`,
      );
    }
    return true;
  }

  private async advanceToReview(draft: IncidentReportDraft): Promise<void> {
    let incident = await this.requireIncident(draft.tenantId, draft.incidentId);
    if (incident.status === 'NEEDS_REVIEW') {
      return;
    }
    if (incident.status === 'GENERATING') {
      incident = await this.transition(incident, 'VERIFYING');
    }
    if (incident.status !== 'VERIFYING') {
      throw new IncidentReportConfigurationError(
        `Completed report cannot advance incident status ${incident.status}`,
      );
    }
    await this.transition(incident, 'NEEDS_REVIEW');
  }

  private async advanceToFailure(draft: IncidentReportDraft): Promise<void> {
    const incident = await this.requireIncident(
      draft.tenantId,
      draft.incidentId,
    );
    if (incident.status === 'FAILED') {
      return;
    }
    if (incident.status !== 'GENERATING' && incident.status !== 'VERIFYING') {
      throw new IncidentReportConfigurationError(
        `Failed report cannot advance incident status ${incident.status}`,
      );
    }
    await this.transition(incident, 'FAILED');
  }

  private async requireIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<Incident> {
    const incident = await this.incidents.findById(tenantId, incidentId);
    if (incident === null) {
      throw new IncidentReportConfigurationError('Incident was not found');
    }
    return incident;
  }

  private async transition(
    incident: Incident,
    status: 'VERIFYING' | 'NEEDS_REVIEW' | 'FAILED',
  ): Promise<Incident> {
    const updated = IncidentAggregate.rehydrate(incident)
      .transitionTo(status, this.clock.now())
      .toSnapshot();
    await this.incidents.save(updated, incident.version);
    return updated;
  }
}

async function deidentifyReportManifest(
  manifest: Awaited<ReturnType<IncidentReportRepository['loadManifest']>>,
  deidentifier: IncidentDeidentifier,
): Promise<Awaited<ReturnType<IncidentReportRepository['loadManifest']>>> {
  const coverage = manifest.coverage ?? [];
  const texts = [
    manifest.incidentTitle,
    ...manifest.claims.map((claim) => claim.statement),
    ...manifest.timeline.map((event) => event.summary),
    ...manifest.openQuestions.map((question) => question.question),
    ...coverage.flatMap((source) => [source.sourceName, source.reason ?? '']),
  ];
  const deidentified = await deidentifier.deidentify({ texts });
  if (deidentified.length !== texts.length) {
    throw new IncidentDeidentificationError(
      'PII_DEIDENTIFIER_INVALID_OUTPUT',
      false,
    );
  }
  let cursor = 0;
  const take = (): string => {
    const value = deidentified[cursor++];
    if (value === undefined) {
      throw new IncidentDeidentificationError(
        'PII_DEIDENTIFIER_INVALID_OUTPUT',
        false,
      );
    }
    return value;
  };
  const incidentTitle = take();
  const claims = manifest.claims.map((claim) => ({
    ...claim,
    statement: take(),
  }));
  const timeline = manifest.timeline.map((event) => ({
    ...event,
    summary: take(),
  }));
  const openQuestions = manifest.openQuestions.map((question) => ({
    ...question,
    question: take(),
  }));
  const deidentifiedCoverage = coverage.map((source) => {
    const sourceName = take();
    const reason = take();
    return {
      ...source,
      sourceName,
      reason: source.reason === null ? null : reason,
    };
  });
  return {
    ...manifest,
    incidentTitle,
    claims,
    timeline,
    openQuestions,
    ...(manifest.coverage === undefined
      ? {}
      : { coverage: deidentifiedCoverage }),
  };
}

function reportText(report: IncidentReport): readonly string[] {
  return report.sections.flatMap((section) =>
    section.statements.flatMap((statement) => [statement.key, statement.text]),
  );
}

function reviewOutcome(
  draft: IncidentReportDraft,
  openQuestionCount: number,
): GenerateIncidentReportOutcome {
  return {
    status: 'NEEDS_REVIEW',
    reportDraftId: draft.id,
    sectionCount: draft.sectionCount,
    statementCount: draft.statementCount,
    openQuestionCount,
  };
}

function retryOutcome(seconds: number): GenerateIncidentReportOutcome {
  return { status: 'RETRY_WAIT', retryAfterSeconds: boundWait(seconds) };
}

function failedOutcome(
  draft: IncidentReportDraft,
): GenerateIncidentReportOutcome {
  return {
    status: 'FAILED',
    reportDraftId: draft.id,
    failureCode: draft.failureCode ?? 'INCIDENT_REPORT_FAILED',
  };
}

function boundWait(seconds: number): number {
  return Math.min(MAX_WORKFLOW_WAIT_SECONDS, Math.max(1, Math.ceil(seconds)));
}

function validateConfiguration(
  configuration: GenerateIncidentReportConfiguration,
): void {
  if (configuration.model.trim().length === 0) {
    throw new Error('Report model must not be empty');
  }
  requireIntegerBetween(configuration.maxSources, 1, 500, 'source limit');
  requireIntegerBetween(
    configuration.maxInputCharacters,
    1_000,
    1_000_000,
    'character limit',
  );
  requireIntegerBetween(configuration.maxAttempts, 1, 5, 'attempt limit');
  requireIntegerBetween(configuration.leaseSeconds, 30, 900, 'lease duration');
}

function requireIntegerBetween(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Report ${label} must be between ${minimum} and ${maximum}`,
    );
  }
}
