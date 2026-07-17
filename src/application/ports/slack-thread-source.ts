export interface SlackThreadSourceMessage {
  readonly messageTs: string;
  readonly occurredAt: Date;
  readonly text: string;
  readonly permalink: string | null;
  readonly authorId?: string;
  readonly editedTs?: string;
  readonly subtype?: string;
  readonly clientMessageId?: string;
}

export interface FetchSlackThreadPageInput {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly cursor?: string;
}

export type FetchSlackThreadPageResult =
  | {
      readonly outcome: 'page';
      readonly messages: readonly SlackThreadSourceMessage[];
      readonly nextCursor: string | null;
    }
  | {
      readonly outcome: 'rate_limited';
      readonly retryAfterSeconds: number;
    };

export interface SlackThreadSource {
  fetchPage(
    input: FetchSlackThreadPageInput,
  ): Promise<FetchSlackThreadPageResult>;
}

export class SlackThreadSourceError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super('Slack thread source request failed', options);
    this.name = 'SlackThreadSourceError';
  }
}

export class SlackThreadRateLimitError extends SlackThreadSourceError {
  public constructor(public readonly retryAfterSeconds: number) {
    super('SLACK_RATE_LIMITED', true);
    this.name = 'SlackThreadRateLimitError';
  }
}
