import { z } from 'zod';
import {
  IncidentParticipantIdentitySourceError,
  type IncidentParticipantIdentity,
  type IncidentParticipantIdentitySource,
} from '../../application/ports/incident-participant-identity-source.js';
import type { SlackBotInstallation } from './web-api-incident-status-notifier.js';

const USERS_INFO_URL = 'https://slack.com/api/users.info';
const MAX_RESPONSE_BYTES = 256 * 1024;
const RESOLUTION_CONCURRENCY = 3;
const externalIdSchema = z.string().regex(/^[A-Z][A-Z0-9]{1,63}$/u);

const userInfoResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      user: z
        .object({
          id: externalIdSchema,
          name: z.string().max(255).default(''),
          profile: z
            .object({
              real_name: z.string().max(255).default(''),
              display_name: z.string().max(255).default(''),
            })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({ ok: z.literal(false), error: z.string().min(1).max(128) })
    .passthrough(),
]);

/** Resolves only incident authors; it never enumerates the workspace directory. */
export class SlackIncidentParticipantIdentitySource implements IncidentParticipantIdentitySource {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(
    private readonly installation: SlackBotInstallation,
    options: {
      readonly request?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {
    if (!/^T[A-Z0-9]{1,63}$/u.test(installation.workspaceId)) {
      throw new Error('Slack bot workspace ID is invalid');
    }
    if (installation.botToken.length === 0) {
      throw new Error('Slack bot token must not be empty');
    }
    this.request = options.request ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('Slack request timeout must be a positive integer');
    }
  }

  public async resolve(
    workspaceId: string,
    rawExternalIds: readonly string[],
  ): Promise<readonly IncidentParticipantIdentity[]> {
    if (workspaceId !== this.installation.workspaceId) {
      throw new IncidentParticipantIdentitySourceError(
        'SLACK_WORKSPACE_MISMATCH',
        false,
      );
    }
    const externalIds = [...new Set(rawExternalIds)].sort();
    for (const externalId of externalIds) {
      if (!externalIdSchema.safeParse(externalId).success) {
        throw new IncidentParticipantIdentitySourceError(
          'SLACK_PARTICIPANT_ID_INVALID',
          false,
        );
      }
    }
    return mapWithConcurrency(externalIds, RESOLUTION_CONCURRENCY, (id) =>
      this.resolveOne(id),
    );
  }

  private async resolveOne(
    externalId: string,
  ): Promise<IncidentParticipantIdentity> {
    const url = new URL(USERS_INFO_URL);
    url.searchParams.set('user', externalId);
    let response: Response;
    try {
      response = await this.request(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.installation.botToken}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new IncidentParticipantIdentitySourceError(
        'SLACK_IDENTITY_NETWORK_ERROR',
        true,
        { cause: error },
      );
    }
    if (response.status === 429) {
      throw new IncidentParticipantIdentitySourceError(
        'SLACK_IDENTITY_RATE_LIMITED',
        true,
      );
    }
    if (!response.ok) {
      throw new IncidentParticipantIdentitySourceError(
        'SLACK_IDENTITY_HTTP_ERROR',
        response.status >= 500,
      );
    }
    const parsed = userInfoResponseSchema.safeParse(
      await parseBoundedJson(response),
    );
    if (!parsed.success) {
      throw new IncidentParticipantIdentitySourceError(
        'SLACK_IDENTITY_INVALID_RESPONSE',
        true,
      );
    }
    if (!parsed.data.ok) {
      const retryable = [
        'internal_error',
        'request_timeout',
        'service_unavailable',
      ].includes(parsed.data.error);
      throw new IncidentParticipantIdentitySourceError(
        retryable
          ? 'SLACK_IDENTITY_UNAVAILABLE'
          : 'SLACK_IDENTITY_REQUEST_REJECTED',
        retryable,
      );
    }
    if (parsed.data.user.id !== externalId) {
      throw new IncidentParticipantIdentitySourceError(
        'SLACK_IDENTITY_RESPONSE_MISMATCH',
        true,
      );
    }
    const aliases = [
      parsed.data.user.name,
      parsed.data.user.profile.real_name,
      parsed.data.user.profile.display_name,
    ]
      .map((alias) => alias.trim())
      .filter(
        (alias, index, values) =>
          alias.length >= 2 && values.indexOf(alias) === index,
      );
    return { externalId, aliases };
  }
}

async function parseBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new IncidentParticipantIdentitySourceError(
      'SLACK_IDENTITY_RESPONSE_TOO_LARGE',
      true,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new IncidentParticipantIdentitySourceError(
      'SLACK_IDENTITY_INVALID_RESPONSE',
      true,
      { cause: error },
    );
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        output[index] = await mapper(values[index] as T);
      }
    }),
  );
  return output;
}
