import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { Logger } from 'pino';
import {
  parseIncidentReviewJob,
  type IncidentReviewJob,
} from '../../domain/incident-review-job.js';

export type IncidentJobHandler = (job: IncidentReviewJob) => Promise<void>;

export interface SqsIncidentJobConsumerOptions {
  readonly client: SQSClient;
  readonly queueUrl: string;
  readonly waitTimeSeconds: number;
  readonly logger: Logger;
}

export class SqsIncidentJobConsumer {
  public constructor(private readonly options: SqsIncidentJobConsumerOptions) {}

  public async run(
    handler: IncidentJobHandler,
    signal: AbortSignal,
  ): Promise<void> {
    this.options.logger.info('incident job consumer started');

    while (!signal.aborted) {
      try {
        await this.poll(handler, signal);
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        this.options.logger.error({ err: error }, 'incident queue poll failed');
        await abortableDelay(1_000, signal);
      }
    }

    this.options.logger.info('incident job consumer stopped');
  }

  private async poll(
    handler: IncidentJobHandler,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.options.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: 10,
        MessageAttributeNames: ['All'],
        WaitTimeSeconds: this.options.waitTimeSeconds,
      }),
      { abortSignal: signal },
    );

    for (const message of response.Messages ?? []) {
      if (signal.aborted) {
        return;
      }
      await this.processMessage(message, handler);
    }
  }

  private async processMessage(
    message: Message,
    handler: IncidentJobHandler,
  ): Promise<void> {
    if (message.Body === undefined || message.ReceiptHandle === undefined) {
      throw new Error(
        'SQS returned a message without a body or receipt handle',
      );
    }

    const job = parseIncidentReviewJob(JSON.parse(message.Body) as unknown);
    await handler(job);

    await this.options.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );

    this.options.logger.info(
      { jobId: job.jobId, sourceEventId: job.source.eventId },
      'incident job acknowledged',
    );
  }
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
