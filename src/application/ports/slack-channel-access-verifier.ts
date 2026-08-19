export type SlackChannelAccessFailureCode =
  | 'APP_NOT_IN_CHANNEL'
  | 'CHANNEL_NOT_FOUND'
  | 'UNSUPPORTED_CHANNEL'
  | 'WORKSPACE_RECONNECT_REQUIRED'
  | 'VERIFICATION_UNAVAILABLE';

export type SlackChannelAccessResult =
  | {
      readonly channelId: string;
      readonly accessible: true;
      readonly displayName: string;
    }
  | {
      readonly channelId: string;
      readonly accessible: false;
      readonly code: SlackChannelAccessFailureCode;
      readonly retryable: boolean;
      readonly displayName: string | null;
    };

/** Performs a bounded, read-only authorization check with workspace credentials. */
export interface SlackChannelAccessVerifier {
  verify(
    workspaceId: string,
    channelIds: readonly string[],
  ): Promise<readonly SlackChannelAccessResult[]>;
}
