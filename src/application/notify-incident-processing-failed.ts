import type { IncidentProcessingFailedNotifier } from './ports/incident-processing-failed-notifier.js';
import type { IncidentRepository } from './ports/incident-repository.js';

export interface NotifyIncidentProcessingFailedCommand {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly failureId: string;
  readonly stage: 'ANALYSIS' | 'REPORT';
}

/** Sends a content-free terminal status after an incident has safely failed closed. */
export class NotifyIncidentProcessingFailed {
  public constructor(
    private readonly incidents: IncidentRepository,
    private readonly notifier: IncidentProcessingFailedNotifier,
  ) {}

  public async execute(
    input: NotifyIncidentProcessingFailedCommand,
  ): Promise<void> {
    const incident = await this.incidents.findById(
      input.tenantId,
      input.incidentId,
    );
    if (incident === null) {
      throw new IncidentProcessingFailureNotificationConfigurationError(
        'Incident was not found',
      );
    }
    if (incident.status !== 'FAILED') {
      throw new IncidentProcessingFailureNotificationConfigurationError(
        'Incident has not reached a terminal failure',
      );
    }
    const threadTs = incident.sourceThreadTs ?? incident.sourceMessageTs;
    if (threadTs === undefined) {
      throw new IncidentProcessingFailureNotificationConfigurationError(
        'Incident has no Slack thread destination',
      );
    }
    await this.notifier.notifyProcessingFailed({
      workspaceId: incident.sourceWorkspaceId,
      incidentId: incident.id,
      failureId: input.failureId,
      channelId: incident.sourceChannelId,
      threadTs,
      stage: input.stage,
    });
  }
}

export class IncidentProcessingFailureNotificationConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IncidentProcessingFailureNotificationConfigurationError';
  }
}
