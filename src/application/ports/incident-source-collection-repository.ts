import type { IncidentSourceStatus } from '../../domain/incident-source.js';

export type CollectionPhase = 'CHANNEL' | 'ANCHOR_THREAD' | 'COMPLETE';
export type PermissionOutcome = 'UNKNOWN' | 'ALLOWED' | 'DENIED' | 'REVOKED';

export interface IncidentSourceCollection {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly sourceId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceKind: 'SLACK_CHANNEL' | 'SLACK_THREAD';
  readonly displayName: string | null;
  readonly requestedStartAt: Date;
  readonly requestedEndAt: Date;
  readonly anchorThreadTimestamps: readonly string[];
  readonly discoveredThreadTimestamps: readonly string[];
  readonly status: IncidentSourceStatus;
  readonly phase: CollectionPhase;
  readonly anchorIndex: number;
  readonly cursor: string | null;
  readonly pagesCollected: number;
  readonly messagesCollected: number;
  readonly rateLimitCount: number;
  readonly transientFailureCount: number;
  readonly checkpointVersion: number;
  readonly retentionDays: number;
}

export interface IncidentSourceMessageArtifact {
  readonly id: string;
  readonly externalId: string;
  readonly sourceUri: string | null;
  readonly authorExternalId?: string;
  readonly occurredAt: Date;
  readonly observedAt: Date;
  readonly content: string;
  readonly contentSha256: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly retentionExpiresAt: Date;
}

export interface AdvanceIncidentSourceCollectionInput {
  readonly collection: IncidentSourceCollection;
  readonly messages: readonly IncidentSourceMessageArtifact[];
  readonly displayName?: string;
  readonly nextPhase: CollectionPhase;
  readonly nextAnchorIndex: number;
  readonly nextCursor: string | null;
  readonly nextDiscoveredThreadTimestamps: readonly string[];
  readonly completed: boolean;
  readonly observedAt: Date;
}

export interface FinishIncidentSourceCollectionInput {
  readonly collection: IncidentSourceCollection;
  readonly status: Extract<
    IncidentSourceStatus,
    'PARTIAL' | 'INACCESSIBLE' | 'REVOKED' | 'FAILED'
  >;
  readonly permissionOutcome: PermissionOutcome;
  readonly reason: string;
  readonly finishedAt: Date;
}

export interface IncidentSourceCollectionRepository {
  getOrCreate(
    tenantId: string,
    incidentId: string,
    sourceId: string,
    runId: string,
    now: Date,
  ): Promise<IncidentSourceCollection>;
  advance(
    input: AdvanceIncidentSourceCollectionInput,
  ): Promise<IncidentSourceCollection>;
  recordRateLimit(
    collection: IncidentSourceCollection,
    retryAfterSeconds: number,
    now: Date,
  ): Promise<IncidentSourceCollection>;
  recordTransientFailure(
    collection: IncidentSourceCollection,
    reason: string,
    retryAfterSeconds: number,
    now: Date,
  ): Promise<IncidentSourceCollection>;
  finish(
    input: FinishIncidentSourceCollectionInput,
  ): Promise<IncidentSourceCollection>;
}

export class IncidentSourceCollectionConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IncidentSourceCollectionConfigurationError';
  }
}

export class IncidentSourceCollectionConcurrencyError extends Error {
  public constructor() {
    super('Incident source collection checkpoint was modified concurrently');
    this.name = 'IncidentSourceCollectionConcurrencyError';
  }
}
