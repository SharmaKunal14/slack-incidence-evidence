export interface IncidentParticipantIdentity {
  readonly externalId: string;
  readonly aliases: readonly string[];
}

export interface IncidentParticipantIdentitySource {
  resolve(
    workspaceId: string,
    externalIds: readonly string[],
  ): Promise<readonly IncidentParticipantIdentity[]>;
}

export class IncidentParticipantIdentitySourceError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super('Incident participant identities could not be resolved', options);
    this.name = 'IncidentParticipantIdentitySourceError';
  }
}
