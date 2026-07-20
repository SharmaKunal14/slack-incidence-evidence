export interface OpenIncidentScopeModalInput {
  readonly triggerId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly defaultStartedAt: Date;
  readonly defaultEndedAt: Date;
  readonly evidenceRetentionDays: number;
}

export interface IncidentScopeModal {
  open(input: OpenIncidentScopeModalInput): Promise<void>;
}

export class IncidentScopeModalError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super('Slack incident scope modal request failed', options);
    this.name = 'IncidentScopeModalError';
  }
}
