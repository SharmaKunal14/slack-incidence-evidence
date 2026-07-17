import { createHash } from 'node:crypto';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { IncidentJobPublisher } from '../../application/ports/incident-job-publisher.js';
import type { IncidentReviewJob } from '../../domain/incident-review-job.js';

export class SqsIncidentJobPublisher implements IncidentJobPublisher {
  public constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  public async publish(job: IncidentReviewJob): Promise<void> {
    const incidentScope = [
      job.source.workspaceId,
      job.source.channelId,
      job.source.threadTs ?? job.source.messageTs,
    ].join('\0');
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(job),
        // Serialize one incident thread, not an entire tenant. Tenant-wide
        // groups create avoidable head-of-line blocking when several incidents
        // are active in the same workspace.
        MessageGroupId: `incident-${createHash('sha256')
          .update(incidentScope, 'utf8')
          .digest('hex')}`,
        // FIFO deduplication suppresses rapid Slack retries. The database remains
        // the durable idempotency boundary after SQS's deduplication window.
        MessageDeduplicationId: createHash('sha256')
          .update(job.source.workspaceId, 'utf8')
          .update('\0', 'utf8')
          .update(job.source.eventId, 'utf8')
          .digest('hex'),
        MessageAttributes: {
          eventType: {
            DataType: 'String',
            StringValue: job.type,
          },
          schemaVersion: {
            DataType: 'Number',
            StringValue: String(job.version),
          },
        },
      }),
    );
  }
}
