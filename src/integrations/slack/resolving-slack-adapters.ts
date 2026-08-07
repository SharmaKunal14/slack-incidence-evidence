import type {
  IncidentParticipantIdentity,
  IncidentParticipantIdentitySource,
} from '../../application/ports/incident-participant-identity-source.js';
import { IncidentParticipantIdentitySourceError } from '../../application/ports/incident-participant-identity-source.js';
import type {
  IncidentProcessingFailedNotification,
  IncidentProcessingFailedNotifier,
} from '../../application/ports/incident-processing-failed-notifier.js';
import type {
  IncidentReportPublishedNotification,
  IncidentReportPublishedNotifier,
} from '../../application/ports/incident-report-published-notifier.js';
import type {
  IncidentReviewReadyNotification,
  IncidentReviewReadyNotifier,
} from '../../application/ports/incident-review-ready-notifier.js';
import type {
  IncidentScopeModal,
  OpenIncidentScopeModalInput,
} from '../../application/ports/incident-scope-modal.js';
import { IncidentScopeModalError } from '../../application/ports/incident-scope-modal.js';
import type {
  IncidentAcceptedNotification,
  IncidentStatusNotifier,
} from '../../application/ports/incident-status-notifier.js';
import {
  SlackInstallationCredentialResolutionError,
  type RuntimeSlackInstallation,
  type SlackInstallationCredentialResolver,
} from '../../application/ports/slack-installation-credential-resolver.js';
import type {
  FetchSlackChannelPageInput,
  FetchSlackChannelPageResult,
  SlackChannelSource,
} from '../../application/ports/slack-channel-source.js';
import { SlackChannelSourceError } from '../../application/ports/slack-channel-source.js';
import type {
  FetchSlackThreadPageInput,
  FetchSlackThreadPageResult,
  SlackThreadSource,
} from '../../application/ports/slack-thread-source.js';
import { SlackThreadSourceError } from '../../application/ports/slack-thread-source.js';
import { SlackWebApiIncidentScopeModal } from './web-api-incident-scope-modal.js';
import { SlackIncidentParticipantIdentitySource } from './web-api-incident-participant-identity-source.js';
import {
  SlackWebApiError,
  SlackWebApiIncidentStatusNotifier,
} from './web-api-incident-status-notifier.js';
import { SlackChannelWebApiSource } from './web-api-slack-channel-source.js';
import { SlackThreadWebApiSource } from './web-api-slack-thread-source.js';

export class ResolvingSlackIncidentScopeModal implements IncidentScopeModal {
  public constructor(
    private readonly resolver: SlackInstallationCredentialResolver,
  ) {}

  public async open(input: OpenIncidentScopeModalInput): Promise<void> {
    let installation: RuntimeSlackInstallation;
    try {
      installation = await this.resolver.resolve(input.workspaceId);
    } catch (error) {
      throw mapModalResolutionError(error);
    }
    await new SlackWebApiIncidentScopeModal(installation).open(input);
  }
}

export class ResolvingSlackThreadSource implements SlackThreadSource {
  public constructor(
    private readonly resolver: SlackInstallationCredentialResolver,
  ) {}

  public async fetchPage(
    input: FetchSlackThreadPageInput,
  ): Promise<FetchSlackThreadPageResult> {
    try {
      const installation = await this.resolver.resolve(input.workspaceId);
      return await new SlackThreadWebApiSource(installation).fetchPage(input);
    } catch (error) {
      if (error instanceof SlackInstallationCredentialResolutionError) {
        throw new SlackThreadSourceError(error.code, error.retryable, {
          cause: error,
        });
      }
      throw error;
    }
  }
}

export class ResolvingSlackChannelSource implements SlackChannelSource {
  public constructor(
    private readonly resolver: SlackInstallationCredentialResolver,
  ) {}

  public async fetchPage(
    input: FetchSlackChannelPageInput,
  ): Promise<FetchSlackChannelPageResult> {
    try {
      const installation = await this.resolver.resolve(input.workspaceId);
      return await new SlackChannelWebApiSource(installation).fetchPage(input);
    } catch (error) {
      if (error instanceof SlackInstallationCredentialResolutionError) {
        throw new SlackChannelSourceError(
          error.code,
          error.retryable,
          isInactiveInstallation(error) ? 'REVOKED' : 'FAILED',
          { cause: error },
        );
      }
      throw error;
    }
  }
}

export class ResolvingSlackParticipantIdentitySource implements IncidentParticipantIdentitySource {
  public constructor(
    private readonly resolver: SlackInstallationCredentialResolver,
  ) {}

  public async resolve(
    workspaceId: string,
    externalIds: readonly string[],
  ): Promise<readonly IncidentParticipantIdentity[]> {
    try {
      const installation = await this.resolver.resolve(workspaceId);
      return await new SlackIncidentParticipantIdentitySource(
        installation,
      ).resolve(workspaceId, externalIds);
    } catch (error) {
      if (error instanceof SlackInstallationCredentialResolutionError) {
        throw new IncidentParticipantIdentitySourceError(
          error.code,
          error.retryable,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

export class ResolvingSlackIncidentStatusNotifier
  implements
    IncidentStatusNotifier,
    IncidentReviewReadyNotifier,
    IncidentProcessingFailedNotifier,
    IncidentReportPublishedNotifier
{
  public constructor(
    private readonly resolver: SlackInstallationCredentialResolver,
    private readonly options: { readonly reviewAppBaseUrl?: string } = {},
  ) {}

  public async notifyAccepted(
    notification: IncidentAcceptedNotification,
  ): Promise<void> {
    const notifier = await this.notifier(notification.workspaceId);
    await notifier.notifyAccepted(notification);
  }

  public async notifyReviewReady(
    notification: IncidentReviewReadyNotification,
  ): Promise<void> {
    const notifier = await this.notifier(notification.workspaceId);
    await notifier.notifyReviewReady(notification);
  }

  public async notifyProcessingFailed(
    notification: IncidentProcessingFailedNotification,
  ): Promise<void> {
    const notifier = await this.notifier(notification.workspaceId);
    await notifier.notifyProcessingFailed(notification);
  }

  public async notifyReportPublished(
    notification: IncidentReportPublishedNotification,
  ): Promise<{ readonly messageTs: string }> {
    const notifier = await this.notifier(notification.workspaceId);
    return notifier.notifyReportPublished(notification);
  }

  private async notifier(
    workspaceId: string,
  ): Promise<SlackWebApiIncidentStatusNotifier> {
    try {
      const installation = await this.resolver.resolve(workspaceId);
      return new SlackWebApiIncidentStatusNotifier(installation, this.options);
    } catch (error) {
      if (
        error instanceof SlackInstallationCredentialResolutionError &&
        !error.retryable
      ) {
        throw new SlackWebApiError(error.code, { cause: error });
      }
      throw error;
    }
  }
}

function mapModalResolutionError(error: unknown): Error {
  if (error instanceof SlackInstallationCredentialResolutionError) {
    return new IncidentScopeModalError(error.code, error.retryable, {
      cause: error,
    });
  }
  return error instanceof Error
    ? error
    : new IncidentScopeModalError('SLACK_INSTALLATION_LOOKUP_FAILED', true);
}

function isInactiveInstallation(
  error: SlackInstallationCredentialResolutionError,
): boolean {
  return [
    'SLACK_INSTALLATION_NOT_ACTIVE',
    'SLACK_INSTALLATION_CREDENTIAL_EXPIRED',
  ].includes(error.code);
}
