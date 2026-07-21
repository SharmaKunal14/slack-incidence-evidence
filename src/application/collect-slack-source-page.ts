import { createHash } from 'node:crypto';
import type { Clock } from './ports/clock.js';
import type { IdGenerator } from './ports/id-generator.js';
import type {
  CollectionPhase,
  IncidentSourceCollection,
  IncidentSourceCollectionRepository,
  IncidentSourceMessageArtifact,
  PermissionOutcome,
} from './ports/incident-source-collection-repository.js';
import {
  SlackChannelSourceError,
  type SlackChannelSource,
  type SlackChannelSourceMessage,
} from './ports/slack-channel-source.js';

const MAX_RATE_LIMIT_WAIT_SECONDS = 900;
const MAX_DISCOVERED_THREADS_HARD_LIMIT = 500;
const DEFAULT_MAX_DISCOVERED_THREADS = 50;
const slackTimestampPattern = /^\d{1,20}\.\d{1,20}$/u;

export interface CollectSlackSourcePageInput {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly sourceId: string;
}

export type CollectSlackSourcePageResult =
  | {
      readonly status: 'CONTINUE' | 'COMPLETE';
      readonly sourceStatus: string;
      readonly sourceId: string;
      readonly messagesCollected: number;
      readonly pagesCollected: number;
    }
  | {
      readonly status: 'RATE_LIMITED';
      readonly sourceId: string;
      readonly retryAfterSeconds: number;
    };

/** Collects one bounded page for one explicitly selected Slack source. */
export class CollectSlackSourcePage {
  public constructor(
    private readonly collections: IncidentSourceCollectionRepository,
    private readonly source: SlackChannelSource,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly maxPages = 1_000,
    private readonly maxDiscoveredThreads = DEFAULT_MAX_DISCOVERED_THREADS,
  ) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
      throw new Error('Slack source page limit must be between 1 and 1000');
    }
    if (
      !Number.isSafeInteger(maxDiscoveredThreads) ||
      maxDiscoveredThreads < 1 ||
      maxDiscoveredThreads > MAX_DISCOVERED_THREADS_HARD_LIMIT
    ) {
      throw new Error(
        'Slack discovered thread limit must be between 1 and 500',
      );
    }
  }

  public async execute(
    input: CollectSlackSourcePageInput,
  ): Promise<CollectSlackSourcePageResult> {
    const collection = await this.collections.getOrCreate(
      input.tenantId,
      input.incidentId,
      input.sourceId,
      this.idGenerator.generate(),
      this.clock.now(),
    );
    if (isTerminal(collection.status)) {
      return completedResult(collection);
    }
    if (collection.pagesCollected >= this.maxPages) {
      return this.finishFailure(collection, 'SLACK_SOURCE_PAGE_LIMIT_EXCEEDED');
    }

    const threadTs =
      collection.phase === 'ANCHOR_THREAD'
        ? collectionThreadTimestamps(collection)[collection.anchorIndex]
        : undefined;
    if (collection.phase === 'ANCHOR_THREAD' && threadTs === undefined) {
      return this.finishFailure(collection, 'SLACK_ANCHOR_CHECKPOINT_INVALID');
    }
    try {
      const page = await this.source.fetchPage({
        workspaceId: collection.workspaceId,
        channelId: collection.channelId,
        phase: collection.phase === 'CHANNEL' ? 'CHANNEL' : 'ANCHOR_THREAD',
        ...(threadTs === undefined ? {} : { threadTs }),
        oldest: collection.requestedStartAt,
        latest: collection.requestedEndAt,
        ...(collection.cursor === null ? {} : { cursor: collection.cursor }),
        includeDisplayName: collection.displayName === null,
      });
      if (page.outcome === 'rate_limited') {
        const retryAfterSeconds = boundRateLimit(page.retryAfterSeconds);
        await this.collections.recordRateLimit(
          collection,
          retryAfterSeconds,
          this.clock.now(),
        );
        return {
          status: 'RATE_LIMITED',
          sourceId: collection.sourceId,
          retryAfterSeconds,
        };
      }
      if (page.nextCursor !== null && page.nextCursor === collection.cursor) {
        return this.finishFailure(collection, 'SLACK_CURSOR_DID_NOT_ADVANCE');
      }
      const nextDiscoveredThreadTimestamps =
        collection.phase === 'CHANNEL'
          ? mergeDiscoveredThreads(
              collection,
              page.threadRootTimestamps,
              this.maxDiscoveredThreads,
            )
          : collection.discoveredThreadTimestamps;
      if (nextDiscoveredThreadTimestamps === null) {
        return this.finishFailure(
          collection,
          'SLACK_DISCOVERED_THREAD_LIMIT_EXCEEDED',
        );
      }
      const next = nextCheckpoint(
        collection,
        page.nextCursor,
        nextDiscoveredThreadTimestamps,
      );
      const observedAt = this.clock.now();
      const retentionExpiresAt = new Date(
        observedAt.getTime() + collection.retentionDays * 86_400_000,
      );
      const persisted = await this.collections.advance({
        collection,
        messages: page.messages.map((message) =>
          this.toArtifact(collection, message, observedAt, retentionExpiresAt),
        ),
        ...(page.displayName === undefined
          ? {}
          : { displayName: page.displayName }),
        nextPhase: next.phase,
        nextAnchorIndex: next.anchorIndex,
        nextCursor: next.cursor,
        nextDiscoveredThreadTimestamps,
        completed: next.phase === 'COMPLETE',
        observedAt,
      });
      return next.phase === 'COMPLETE'
        ? completedResult(persisted)
        : {
            status: 'CONTINUE',
            sourceStatus: persisted.status,
            sourceId: persisted.sourceId,
            messagesCollected: persisted.messagesCollected,
            pagesCollected: persisted.pagesCollected,
          };
    } catch (error) {
      if (error instanceof SlackChannelSourceError) {
        const reason = normalizeReason(error.code);
        if (error.retryable && collection.transientFailureCount < 2) {
          const retryAfterSeconds = 2 ** (collection.transientFailureCount + 1);
          await this.collections.recordTransientFailure(
            collection,
            reason,
            retryAfterSeconds,
            this.clock.now(),
          );
          return {
            status: 'RATE_LIMITED',
            sourceId: collection.sourceId,
            retryAfterSeconds,
          };
        }
        return this.finishFailure(collection, reason, error.terminalStatus);
      }
      throw error;
    }
  }

  private async finishFailure(
    collection: IncidentSourceCollection,
    reason: string,
    requestedStatus: 'INACCESSIBLE' | 'REVOKED' | 'FAILED' = 'FAILED',
  ): Promise<CollectSlackSourcePageResult> {
    const status =
      collection.messagesCollected > 0 ? 'PARTIAL' : requestedStatus;
    const permissionOutcome: PermissionOutcome =
      requestedStatus === 'INACCESSIBLE'
        ? 'DENIED'
        : requestedStatus === 'REVOKED'
          ? 'REVOKED'
          : 'UNKNOWN';
    const persisted = await this.collections.finish({
      collection,
      status,
      permissionOutcome,
      reason: normalizeReason(reason),
      finishedAt: this.clock.now(),
    });
    return completedResult(persisted);
  }

  private toArtifact(
    collection: IncidentSourceCollection,
    message: SlackChannelSourceMessage,
    observedAt: Date,
    retentionExpiresAt: Date,
  ): IncidentSourceMessageArtifact {
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
        collectionType:
          collection.phase === 'CHANNEL'
            ? 'SLACK_CHANNEL'
            : 'SLACK_ANCHOR_THREAD',
        sourceId: collection.sourceId,
        workspaceId: collection.workspaceId,
        channelId: collection.channelId,
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

function nextCheckpoint(
  collection: IncidentSourceCollection,
  nextCursor: string | null,
  discoveredThreadTimestamps: readonly string[],
): {
  readonly phase: CollectionPhase;
  readonly anchorIndex: number;
  readonly cursor: string | null;
} {
  if (nextCursor !== null) {
    return {
      phase: collection.phase,
      anchorIndex: collection.anchorIndex,
      cursor: nextCursor,
    };
  }
  if (collection.phase === 'CHANNEL') {
    return collectionThreadTimestamps(collection, discoveredThreadTimestamps)
      .length > 0
      ? { phase: 'ANCHOR_THREAD', anchorIndex: 0, cursor: null }
      : { phase: 'COMPLETE', anchorIndex: 0, cursor: null };
  }
  const nextAnchor = collection.anchorIndex + 1;
  return nextAnchor <
    collectionThreadTimestamps(collection, discoveredThreadTimestamps).length
    ? { phase: 'ANCHOR_THREAD', anchorIndex: nextAnchor, cursor: null }
    : { phase: 'COMPLETE', anchorIndex: nextAnchor, cursor: null };
}

function mergeDiscoveredThreads(
  collection: IncidentSourceCollection,
  pageThreadTimestamps: readonly string[],
  limit: number,
): readonly string[] | null {
  const explicitAnchors = new Set(collection.anchorThreadTimestamps);
  const discovered = new Set(collection.discoveredThreadTimestamps);
  for (const timestamp of pageThreadTimestamps) {
    if (!slackTimestampPattern.test(timestamp)) {
      throw new SlackChannelSourceError('SLACK_INVALID_RESPONSE', true);
    }
    if (!explicitAnchors.has(timestamp)) {
      discovered.add(timestamp);
    }
    if (discovered.size > limit) {
      return null;
    }
  }
  return [...discovered];
}

function collectionThreadTimestamps(
  collection: IncidentSourceCollection,
  discoveredThreadTimestamps = collection.discoveredThreadTimestamps,
): readonly string[] {
  const timestamps = new Set(collection.anchorThreadTimestamps);
  for (const timestamp of discoveredThreadTimestamps) {
    timestamps.add(timestamp);
  }
  return [...timestamps];
}

function completedResult(
  collection: IncidentSourceCollection,
): CollectSlackSourcePageResult {
  return {
    status: 'COMPLETE',
    sourceStatus: collection.status,
    sourceId: collection.sourceId,
    messagesCollected: collection.messagesCollected,
    pagesCollected: collection.pagesCollected,
  };
}

function isTerminal(status: IncidentSourceCollection['status']): boolean {
  return status !== 'PLANNED' && status !== 'COLLECTING';
}

function boundRateLimit(value: number): number {
  return Math.min(
    MAX_RATE_LIMIT_WAIT_SECONDS,
    Math.max(1, Number.isFinite(value) ? Math.ceil(value) : 60),
  );
}

function normalizeReason(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
  return normalized.slice(0, 64) || 'SLACK_SOURCE_FAILED';
}
