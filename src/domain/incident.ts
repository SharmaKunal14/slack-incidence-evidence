export const INCIDENT_STATUSES = [
  'DISCOVERED',
  'COLLECTING',
  'NORMALIZING',
  'EXTRACTING',
  'GENERATING',
  'VERIFYING',
  'NEEDS_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'CLOSED',
  'FAILED',
] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_SEVERITIES = [
  'UNCLASSIFIED',
  'SEV0',
  'SEV1',
  'SEV2',
  'SEV3',
  'SEV4',
] as const;

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export interface Incident {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceEventId: string;
  readonly sourceWorkspaceId: string;
  readonly sourceChannelId: string;
  readonly sourceMessageTs?: string;
  readonly sourceThreadTs?: string;
  readonly requestedByUserId: string;
  readonly reviewerUserId?: string;
  readonly evidenceRetentionDays?: number;
  readonly title: string;
  readonly status: IncidentStatus;
  readonly severity: IncidentSeverity;
  readonly startedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface CreateIncident {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceEventId: string;
  readonly sourceWorkspaceId: string;
  readonly sourceChannelId: string;
  readonly sourceMessageTs: string;
  readonly sourceThreadTs?: string;
  readonly requestedByUserId: string;
  readonly reviewerUserId?: string;
  readonly evidenceRetentionDays?: number;
  readonly title: string;
  readonly startedAt?: Date;
  readonly resolvedAt?: Date;
  readonly severity?: IncidentSeverity;
  readonly now: Date;
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<IncidentStatus, readonly IncidentStatus[]>
> = {
  DISCOVERED: ['COLLECTING', 'FAILED'],
  COLLECTING: ['NORMALIZING', 'FAILED'],
  NORMALIZING: ['EXTRACTING', 'FAILED'],
  EXTRACTING: ['GENERATING', 'FAILED'],
  GENERATING: ['VERIFYING', 'FAILED'],
  VERIFYING: ['NEEDS_REVIEW', 'FAILED'],
  NEEDS_REVIEW: ['APPROVED', 'FAILED'],
  APPROVED: ['PUBLISHED', 'FAILED'],
  PUBLISHED: ['CLOSED'],
  CLOSED: [],
  FAILED: [],
};

export class InvalidIncidentTransitionError extends Error {
  public constructor(from: IncidentStatus, to: IncidentStatus) {
    super(`Incident cannot transition from ${from} to ${to}`);
    this.name = 'InvalidIncidentTransitionError';
  }
}

/**
 * The aggregate owns lifecycle invariants. Persistence and transport layers only
 * exchange immutable snapshots so they cannot bypass the transition rules.
 */
export class IncidentAggregate {
  private constructor(private snapshot: Incident) {}

  public static create(input: CreateIncident): IncidentAggregate {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new Error('Incident title must not be empty');
    }

    return new IncidentAggregate({
      id: input.id,
      tenantId: input.tenantId,
      sourceEventId: input.sourceEventId,
      sourceWorkspaceId: input.sourceWorkspaceId,
      sourceChannelId: input.sourceChannelId,
      sourceMessageTs: input.sourceMessageTs,
      ...(input.sourceThreadTs === undefined
        ? {}
        : { sourceThreadTs: input.sourceThreadTs }),
      requestedByUserId: input.requestedByUserId,
      ...(input.reviewerUserId === undefined
        ? {}
        : { reviewerUserId: input.reviewerUserId }),
      ...(input.evidenceRetentionDays === undefined
        ? {}
        : { evidenceRetentionDays: input.evidenceRetentionDays }),
      title,
      status: 'DISCOVERED',
      severity: input.severity ?? 'UNCLASSIFIED',
      startedAt: input.startedAt ?? null,
      resolvedAt: input.resolvedAt ?? null,
      createdAt: input.now,
      updatedAt: input.now,
      version: 0,
    });
  }

  public static rehydrate(snapshot: Incident): IncidentAggregate {
    return new IncidentAggregate(snapshot);
  }

  public transitionTo(status: IncidentStatus, now: Date): IncidentAggregate {
    if (!ALLOWED_TRANSITIONS[this.snapshot.status].includes(status)) {
      throw new InvalidIncidentTransitionError(this.snapshot.status, status);
    }

    return new IncidentAggregate({
      ...this.snapshot,
      status,
      updatedAt: now,
      version: this.snapshot.version + 1,
    });
  }

  public toSnapshot(): Incident {
    return { ...this.snapshot };
  }
}
