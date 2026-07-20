export interface SlackChannelSourceMessage {
  readonly messageTs: string;
  readonly occurredAt: Date;
  readonly text: string;
  readonly permalink: string | null;
  readonly authorId?: string;
  readonly editedTs?: string;
  readonly subtype?: string;
  readonly clientMessageId?: string;
}

export interface FetchSlackChannelPageInput {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly phase: 'CHANNEL' | 'ANCHOR_THREAD';
  readonly threadTs?: string;
  readonly oldest: Date;
  readonly latest: Date;
  readonly cursor?: string;
  readonly includeDisplayName: boolean;
}

export type FetchSlackChannelPageResult =
  | {
      readonly outcome: 'page';
      readonly messages: readonly SlackChannelSourceMessage[];
      readonly nextCursor: string | null;
      readonly displayName?: string;
    }
  | { readonly outcome: 'rate_limited'; readonly retryAfterSeconds: number };

export interface SlackChannelSource {
  fetchPage(
    input: FetchSlackChannelPageInput,
  ): Promise<FetchSlackChannelPageResult>;
}

export class SlackChannelSourceError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly terminalStatus:
      'INACCESSIBLE' | 'REVOKED' | 'FAILED' = 'FAILED',
    options?: ErrorOptions,
  ) {
    super('Slack channel source request failed', options);
    this.name = 'SlackChannelSourceError';
  }
}
