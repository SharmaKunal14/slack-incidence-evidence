import { createHash } from 'node:crypto';
import type { Clock } from './ports/clock.js';
import type { IdGenerator } from './ports/id-generator.js';
import type {
  SlackMessageArtifact,
  SlackThreadCollection,
  SlackThreadCollectionRepository,
} from './ports/slack-thread-collection-repository.js';
import {
  SlackThreadRateLimitError,
  SlackThreadSourceError,
  type SlackThreadSource,
  type SlackThreadSourceMessage,
} from './ports/slack-thread-source.js';

const MAX_RATE_LIMIT_WAIT_SECONDS = 900;

export interface CollectSlackThreadPageInput {
  readonly tenantId: string;
  readonly incidentId: string;
}

export type CollectSlackThreadPageResult =
  | {
      readonly status: 'CONTINUE' | 'COMPLETE';
      readonly messagesCollected: number;
      readonly pagesCollected: number;
    }
  | {
      readonly status: 'RATE_LIMITED';
      readonly retryAfterSeconds: number;
    }
  | {
      readonly status: 'FAILED';
      readonly failureCode: string;
    };

/** Collects one durable page so orchestration, not Lambda, owns waiting. */
export class CollectSlackThreadPage {
  public constructor(
    private readonly collections: SlackThreadCollectionRepository,
    private readonly source: SlackThreadSource,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly retentionDays: number,
    private readonly maxPages = 100,
  ) {
    if (
      !Number.isSafeInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 365
    ) {
      throw new Error('Evidence retention days must be between 1 and 365');
    }
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
      throw new Error('Slack thread page limit must be between 1 and 1000');
    }
  }

  public async execute(
    input: CollectSlackThreadPageInput,
  ): Promise<CollectSlackThreadPageResult> {
    const collection = await this.collections.getOrCreate(
      input.tenantId,
      input.incidentId,
    );
    if (collection.status === 'COMPLETE') {
      return collectionResult(collection);
    }
    if (collection.status === 'FAILED') {
      return {
        status: 'FAILED',
        failureCode: collection.failureCode ?? 'SLACK_COLLECTION_FAILED',
      };
    }
    if (collection.pagesCollected >= this.maxPages) {
      return this.failCollection(
        collection,
        'SLACK_THREAD_PAGE_LIMIT_EXCEEDED',
      );
    }

    try {
      const page = await this.source.fetchPage({
        workspaceId: collection.workspaceId,
        channelId: collection.channelId,
        threadTs: collection.threadTs,
        ...(collection.nextCursor === null
          ? {}
          : { cursor: collection.nextCursor }),
      });
      if (page.outcome === 'rate_limited') {
        return {
          status: 'RATE_LIMITED',
          retryAfterSeconds: Math.min(
            MAX_RATE_LIMIT_WAIT_SECONDS,
            Math.max(1, page.retryAfterSeconds),
          ),
        };
      }
      if (
        page.nextCursor !== null &&
        page.nextCursor === collection.nextCursor
      ) {
        return this.failCollection(collection, 'SLACK_CURSOR_DID_NOT_ADVANCE');
      }

      const observedAt = this.clock.now();
      const retentionExpiresAt = new Date(
        observedAt.getTime() + this.retentionDays * 86_400_000,
      );
      const persisted = await this.collections.savePage({
        collection,
        messages: page.messages.map((message) =>
          this.toArtifact(collection, message, observedAt, retentionExpiresAt),
        ),
        nextCursor: page.nextCursor,
        observedAt,
      });
      return collectionResult(persisted);
    } catch (error) {
      if (error instanceof SlackThreadRateLimitError) {
        return {
          status: 'RATE_LIMITED',
          retryAfterSeconds: Math.min(
            MAX_RATE_LIMIT_WAIT_SECONDS,
            Math.max(1, error.retryAfterSeconds),
          ),
        };
      }
      if (error instanceof SlackThreadSourceError && !error.retryable) {
        return this.failCollection(collection, error.code);
      }
      throw error;
    }
  }

  private async failCollection(
    collection: SlackThreadCollection,
    failureCode: string,
  ): Promise<CollectSlackThreadPageResult> {
    const failed = await this.collections.fail({
      collection,
      failureCode,
      failedAt: this.clock.now(),
    });
    return {
      status: 'FAILED',
      failureCode: failed.failureCode ?? 'SLACK_COLLECTION_FAILED',
    };
  }

  private toArtifact(
    collection: SlackThreadCollection,
    message: SlackThreadSourceMessage,
    observedAt: Date,
    retentionExpiresAt: Date,
  ): SlackMessageArtifact {
    return {
      id: this.idGenerator.generate(),
      externalId: [
        'slack',
        collection.workspaceId,
        collection.channelId,
        message.messageTs,
      ].join(':'),
      sourceUri: message.permalink,
      ...(message.authorId === undefined
        ? {}
        : { authorExternalId: message.authorId }),
      occurredAt: message.occurredAt,
      observedAt,
      content: message.text,
      contentSha256: createHash('sha256')
        .update(message.text, 'utf8')
        .digest('hex'),
      metadata: {
        provider: 'slack',
        collectionType: 'SLACK_THREAD',
        workspaceId: collection.workspaceId,
        channelId: collection.channelId,
        threadTs: collection.threadTs,
        messageTs: message.messageTs,
        ...(message.editedTs === undefined
          ? {}
          : { editedTs: message.editedTs }),
        ...(message.subtype === undefined ? {} : { subtype: message.subtype }),
        ...(message.clientMessageId === undefined
          ? {}
          : { clientMessageId: message.clientMessageId }),
        permalinkStatus:
          message.permalink === null ? 'UNAVAILABLE' : 'AVAILABLE',
      },
      retentionExpiresAt,
    };
  }
}

function collectionResult(
  collection: SlackThreadCollection,
): CollectSlackThreadPageResult {
  return {
    status: collection.status === 'COMPLETE' ? 'COMPLETE' : 'CONTINUE',
    messagesCollected: collection.messagesCollected,
    pagesCollected: collection.pagesCollected,
  };
}
