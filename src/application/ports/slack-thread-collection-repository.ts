export type SlackThreadCollectionStatus = 'RUNNING' | 'COMPLETE' | 'FAILED';

export interface SlackThreadCollection {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly status: SlackThreadCollectionStatus;
  readonly nextCursor: string | null;
  readonly messagesCollected: number;
  readonly pagesCollected: number;
  readonly failureCode: string | null;
  readonly version: number;
}

export interface SlackMessageArtifact {
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

export interface SaveSlackThreadPageInput {
  readonly collection: SlackThreadCollection;
  readonly messages: readonly SlackMessageArtifact[];
  readonly nextCursor: string | null;
  readonly observedAt: Date;
}

export interface FailSlackThreadCollectionInput {
  readonly collection: SlackThreadCollection;
  readonly failureCode: string;
  readonly failedAt: Date;
}

export interface SlackThreadCollectionRepository {
  getOrCreate(
    tenantId: string,
    incidentId: string,
  ): Promise<SlackThreadCollection>;
  savePage(input: SaveSlackThreadPageInput): Promise<SlackThreadCollection>;
  fail(input: FailSlackThreadCollectionInput): Promise<SlackThreadCollection>;
}

export class SlackThreadCollectionConcurrencyError extends Error {
  public constructor() {
    super('Slack thread collection checkpoint was modified concurrently');
    this.name = 'SlackThreadCollectionConcurrencyError';
  }
}

export class SlackThreadCollectionConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SlackThreadCollectionConfigurationError';
  }
}
