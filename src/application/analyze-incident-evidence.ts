import { createHash } from 'node:crypto';
import type { Clock } from './ports/clock.js';
import type { IdGenerator } from './ports/id-generator.js';
import {
  IncidentAnalysisConfigurationError,
  type IncidentAnalysisRepository,
  type IncidentAnalysisRun,
} from './ports/incident-analysis-repository.js';
import {
  IncidentAnalyzerError,
  type IncidentAnalyzer,
  type IncidentEvidenceManifest,
} from './ports/incident-analyzer.js';
import type { IncidentRepository } from './ports/incident-repository.js';
import {
  IncidentDeidentificationError,
  type IncidentDeidentifier,
  type KnownIncidentPerson,
} from './ports/incident-deidentifier.js';
import {
  IncidentParticipantIdentitySourceError,
  type IncidentParticipantIdentitySource,
} from './ports/incident-participant-identity-source.js';
import { IncidentAggregate, type Incident } from '../domain/incident.js';

const ANALYSIS_VERSION = 2;
const PROVIDER = 'openai';
const PROMPT_VERSION = 'incident-extraction-deidentified-v3';
const SCHEMA_VERSION = 'incident-analysis-v2';
const MAX_WORKFLOW_WAIT_SECONDS = 900;

export interface AnalyzeIncidentEvidenceCommand {
  readonly tenantId: string;
  readonly incidentId: string;
}

export type AnalyzeIncidentEvidenceOutcome =
  | {
      readonly status: 'COMPLETE';
      readonly analysisRunId: string;
      readonly timelineEventCount: number;
      readonly claimCount: number;
      readonly openQuestionCount: number;
    }
  | {
      readonly status: 'RETRY_WAIT';
      readonly retryAfterSeconds: number;
    }
  | {
      readonly status: 'FAILED';
      readonly analysisRunId: string;
      readonly failureCode: string;
    };

export interface AnalyzeIncidentEvidenceConfiguration {
  readonly model: string;
  readonly maxArtifacts: number;
  readonly maxInputCharacters: number;
  readonly maxAttempts: number;
  readonly leaseSeconds: number;
}

/** Coordinates bounded, leased and evidence-cited model extraction. */
export class AnalyzeIncidentEvidence {
  public constructor(
    private readonly analyses: IncidentAnalysisRepository,
    private readonly incidents: IncidentRepository,
    private readonly analyzer: IncidentAnalyzer,
    private readonly participantIdentities: IncidentParticipantIdentitySource,
    private readonly deidentifier: IncidentDeidentifier,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly configuration: AnalyzeIncidentEvidenceConfiguration,
  ) {
    validateConfiguration(configuration);
  }

  public async execute(
    input: AnalyzeIncidentEvidenceCommand,
  ): Promise<AnalyzeIncidentEvidenceOutcome> {
    const evidence = await this.analyses.loadEvidence(
      input.tenantId,
      input.incidentId,
      this.configuration.maxArtifacts + 1,
    );
    if (evidence.artifacts.length === 0) {
      throw new IncidentAnalysisConfigurationError(
        'No incident evidence is available for analysis',
      );
    }
    if (evidence.artifacts.length > this.configuration.maxArtifacts) {
      throw new IncidentAnalysisConfigurationError(
        'Incident evidence exceeds the configured artifact limit',
      );
    }

    const authorReferences = new Map<string, string>();
    const rawManifest: IncidentEvidenceManifest = {
      incidentTitle: evidence.incidentTitle,
      evidence: evidence.artifacts.map((artifact) => ({
        id: artifact.id,
        sourceType: artifact.sourceType,
        occurredAt: artifact.occurredAt.toISOString(),
        authorReference:
          artifact.authorExternalId === null
            ? null
            : pseudonymizeAuthor(artifact.authorExternalId, authorReferences),
        content: artifact.content,
      })),
    };
    const serializedManifest = JSON.stringify(rawManifest);
    if (serializedManifest.length > this.configuration.maxInputCharacters) {
      throw new IncidentAnalysisConfigurationError(
        'Incident evidence exceeds the configured character limit',
      );
    }

    const incidentCanRun = await this.advanceToExtraction(
      input.tenantId,
      input.incidentId,
    );

    const now = this.clock.now();
    const leaseToken = this.idGenerator.generate();
    const acquired = await this.analyses.acquire({
      id: this.idGenerator.generate(),
      tenantId: input.tenantId,
      incidentId: input.incidentId,
      analysisVersion: ANALYSIS_VERSION,
      manifestSha256: createHash('sha256')
        .update(serializedManifest, 'utf8')
        .digest('hex'),
      provider: PROVIDER,
      model: this.configuration.model,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      clientRequestId: this.idGenerator.generate(),
      inputArtifactCount: rawManifest.evidence.length,
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
        return {
          status: 'RETRY_WAIT',
          retryAfterSeconds: boundWait(acquired.retryAfterSeconds),
        };
      }
      if (acquired.outcome === 'COMPLETE') {
        return completeOutcome(acquired.run);
      }
      if (acquired.outcome === 'FAILED') {
        return failedOutcome(acquired.run);
      }
      const failed = await this.analyses.fail({
        run: acquired.run,
        leaseToken,
        failureCode: 'INCIDENT_ALREADY_FAILED',
        failedAt: this.clock.now(),
      });
      return failedOutcome(failed);
    }

    if (acquired.outcome === 'WAIT') {
      return {
        status: 'RETRY_WAIT',
        retryAfterSeconds: boundWait(acquired.retryAfterSeconds),
      };
    }
    if (acquired.outcome === 'COMPLETE') {
      await this.advanceToGeneration(acquired.run);
      return completeOutcome(acquired.run);
    }
    if (acquired.outcome === 'FAILED') {
      await this.advanceToFailure(acquired.run);
      return failedOutcome(acquired.run);
    }

    const run = acquired.run;
    try {
      const incident = await this.requireIncident(
        input.tenantId,
        input.incidentId,
      );
      const knownPeople = await this.resolveKnownPeople(
        incident.sourceWorkspaceId,
        authorReferences,
      );
      const deidentifiedTexts = await this.deidentifier.deidentify({
        texts: [
          rawManifest.incidentTitle,
          ...rawManifest.evidence.map((artifact) => artifact.content),
        ],
        knownPeople,
      });
      if (deidentifiedTexts.length !== rawManifest.evidence.length + 1) {
        throw new IncidentDeidentificationError(
          'PII_DEIDENTIFIER_INVALID_OUTPUT',
          false,
        );
      }
      const incidentTitle = deidentifiedTexts[0];
      if (incidentTitle === undefined) {
        throw new IncidentDeidentificationError(
          'PII_DEIDENTIFIER_INVALID_OUTPUT',
          false,
        );
      }
      const manifest: IncidentEvidenceManifest = {
        incidentTitle,
        evidence: rawManifest.evidence.map((artifact, index) => {
          const content = deidentifiedTexts[index + 1];
          if (content === undefined) {
            throw new IncidentDeidentificationError(
              'PII_DEIDENTIFIER_INVALID_OUTPUT',
              false,
            );
          }
          return { ...artifact, content };
        }),
      };
      const result = await this.analyzer.analyze({
        manifest,
        availableEvidenceIds: new Set(
          manifest.evidence.map((artifact) => artifact.id),
        ),
        clientRequestId: run.clientRequestId,
      });
      await this.deidentifier.assertSafe({
        texts: analysisText(result.analysis),
        knownPeople,
      });
      const completed = await this.analyses.complete({
        run,
        leaseToken,
        analysis: result.analysis,
        providerResponseId: result.providerResponseId,
        providerModel: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        completedAt: this.clock.now(),
      });
      await this.advanceToGeneration(completed);
      return completeOutcome(completed);
    } catch (error) {
      if (
        !(error instanceof IncidentAnalyzerError) &&
        !(error instanceof IncidentDeidentificationError) &&
        !(error instanceof IncidentParticipantIdentitySourceError)
      ) {
        throw error;
      }
      if (error.retryable && run.attemptCount < run.maxAttempts) {
        const retryAfterSeconds = boundWait(
          (error instanceof IncidentAnalyzerError
            ? error.retryAfterSeconds
            : null) ?? 2 ** run.attemptCount,
        );
        const retryAt = new Date(
          this.clock.now().getTime() + retryAfterSeconds * 1_000,
        );
        await this.analyses.scheduleRetry({
          run,
          leaseToken,
          failureCode: error.code,
          availableAt: retryAt,
          now: this.clock.now(),
        });
        return { status: 'RETRY_WAIT', retryAfterSeconds };
      }

      const failed = await this.analyses.fail({
        run,
        leaseToken,
        failureCode: error.code,
        failedAt: this.clock.now(),
      });
      await this.advanceToFailure(failed);
      return failedOutcome(failed);
    }
  }

  private async resolveKnownPeople(
    workspaceId: string,
    authorReferences: ReadonlyMap<string, string>,
  ): Promise<readonly KnownIncidentPerson[]> {
    const resolvableIds = [...authorReferences.keys()].filter((id) =>
      /^[UW][A-Z0-9]{1,63}$/u.test(id),
    );
    const identities = await this.participantIdentities.resolve(
      workspaceId,
      resolvableIds,
    );
    const aliasesById = new Map(
      identities.map((identity) => [identity.externalId, identity.aliases]),
    );
    return [...authorReferences.entries()].map(([externalId, replacement]) => ({
      externalId,
      replacement,
      aliases: aliasesById.get(externalId) ?? [],
    }));
  }

  private async advanceToExtraction(
    tenantId: string,
    incidentId: string,
  ): Promise<boolean> {
    let incident = await this.requireIncident(tenantId, incidentId);
    if (incident.status === 'FAILED') {
      return false;
    }
    if (incident.status === 'COLLECTING') {
      incident = await this.transition(incident, 'NORMALIZING');
    }
    if (incident.status === 'NORMALIZING') {
      await this.transition(incident, 'EXTRACTING');
      return true;
    }
    if (incident.status !== 'EXTRACTING' && incident.status !== 'GENERATING') {
      throw new IncidentAnalysisConfigurationError(
        `Incident status ${incident.status} cannot enter extraction`,
      );
    }
    return true;
  }

  private async advanceToGeneration(run: IncidentAnalysisRun): Promise<void> {
    const incident = await this.requireIncident(run.tenantId, run.incidentId);
    if (incident.status === 'GENERATING') {
      return;
    }
    if (incident.status !== 'EXTRACTING') {
      throw new IncidentAnalysisConfigurationError(
        `Completed analysis cannot advance incident status ${incident.status}`,
      );
    }
    await this.transition(incident, 'GENERATING');
  }

  private async advanceToFailure(run: IncidentAnalysisRun): Promise<void> {
    const incident = await this.requireIncident(run.tenantId, run.incidentId);
    if (incident.status === 'FAILED') {
      return;
    }
    if (incident.status !== 'EXTRACTING') {
      throw new IncidentAnalysisConfigurationError(
        `Failed analysis cannot advance incident status ${incident.status}`,
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
      throw new IncidentAnalysisConfigurationError('Incident was not found');
    }
    return incident;
  }

  private async transition(
    incident: Incident,
    status: 'NORMALIZING' | 'EXTRACTING' | 'GENERATING' | 'FAILED',
  ): Promise<Incident> {
    const updated = IncidentAggregate.rehydrate(incident)
      .transitionTo(status, this.clock.now())
      .toSnapshot();
    await this.incidents.save(updated, incident.version);
    return updated;
  }
}

function analysisText(
  analysis: Awaited<ReturnType<IncidentAnalyzer['analyze']>>['analysis'],
): readonly string[] {
  return [
    ...analysis.timeline.flatMap((event) => [event.key, event.summary]),
    ...analysis.claims.flatMap((claim) => [claim.key, claim.statement]),
    ...analysis.openQuestions.flatMap((question) => [
      question.key,
      question.question,
    ]),
  ];
}

function pseudonymizeAuthor(
  authorId: string,
  references: Map<string, string>,
): string {
  const existing = references.get(authorId);
  if (existing !== undefined) {
    return existing;
  }
  const reference = `participant_${references.size + 1}`;
  references.set(authorId, reference);
  return reference;
}

function completeOutcome(
  run: IncidentAnalysisRun,
): AnalyzeIncidentEvidenceOutcome {
  return {
    status: 'COMPLETE',
    analysisRunId: run.id,
    timelineEventCount: run.timelineEventCount,
    claimCount: run.claimCount,
    openQuestionCount: run.openQuestionCount,
  };
}

function failedOutcome(
  run: IncidentAnalysisRun,
): AnalyzeIncidentEvidenceOutcome {
  return {
    status: 'FAILED',
    analysisRunId: run.id,
    failureCode: run.failureCode ?? 'INCIDENT_ANALYSIS_FAILED',
  };
}

function boundWait(seconds: number): number {
  return Math.min(MAX_WORKFLOW_WAIT_SECONDS, Math.max(1, Math.ceil(seconds)));
}

function validateConfiguration(
  configuration: AnalyzeIncidentEvidenceConfiguration,
): void {
  if (configuration.model.trim().length === 0) {
    throw new Error('Analysis model must not be empty');
  }
  requireIntegerBetween(configuration.maxArtifacts, 1, 500, 'artifact limit');
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
      `Analysis ${label} must be between ${minimum} and ${maximum}`,
    );
  }
}
