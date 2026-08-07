import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { SendEmailCommand, SESv2ServiceException } from '@aws-sdk/client-sesv2';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceInvitationEmailError } from '../../../src/application/ports/workspace-invitation-email-sender.js';
import { SesWorkspaceInvitationEmailSender } from '../../../src/integrations/aws/ses-workspace-invitation-email-sender.js';

type Send = (command: unknown) => Promise<unknown>;

function createClient(send: Send): SESv2Client {
  return { send } as unknown as SESv2Client;
}

describe('SesWorkspaceInvitationEmailSender', () => {
  it('sends bounded text and HTML invitation content through SES', async () => {
    const send = vi.fn<Send>().mockResolvedValue({ MessageId: 'message-1' });
    const sender = new SesWorkspaceInvitationEmailSender(createClient(send), {
      fromAddress: 'invites@onrecord.example.test',
      applicationBaseUrl: 'https://review.example.test/',
    });

    await expect(
      sender.send({
        recipientEmail: 'reviewer@example.test',
        invitationUrl:
          'https://review.example.test/#/invitations/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        workspaceDisplayName: 'Engineering & Reliability',
        role: 'REVIEWER',
        expiresAt: new Date('2026-08-14T01:00:00.000Z'),
      }),
    ).resolves.toEqual({ providerMessageId: 'message-1' });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect((command as SendEmailCommand).input).toMatchObject({
      FromEmailAddress: 'invites@onrecord.example.test',
      Destination: { ToAddresses: ['reviewer@example.test'] },
    });
    const html = (command as SendEmailCommand).input.Content?.Simple?.Body?.Html
      ?.Data;
    expect(html).toContain('Engineering &amp; Reliability');
    expect(html).toContain('OnRecord will never ask for your Slack password');
  });

  it('returns bounded SES diagnostics without exposing provider messages', async () => {
    const send = vi.fn<Send>().mockRejectedValue(
      new SESv2ServiceException({
        name: 'MessageRejected',
        $fault: 'client',
        $metadata: {
          httpStatusCode: 400,
          requestId: 'safe-request-id',
        },
      }),
    );
    const sender = new SesWorkspaceInvitationEmailSender(createClient(send), {
      fromAddress: 'invites@onrecord.example.test',
      applicationBaseUrl: 'https://review.example.test/',
    });

    await expect(
      sender.send({
        recipientEmail: 'reviewer@example.test',
        invitationUrl:
          'https://review.example.test/#/invitations/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        workspaceDisplayName: 'Engineering',
        role: 'VIEWER',
        expiresAt: new Date('2026-08-14T01:00:00.000Z'),
      }),
    ).rejects.toEqual(
      new WorkspaceInvitationEmailError({
        stage: 'REQUEST',
        code: 'PROVIDER_REJECTED',
        retryable: false,
        providerCode: 'MessageRejected',
        providerRequestId: 'safe-request-id',
        httpStatusCode: 400,
      }),
    );
  });

  it('classifies invalid inputs before calling SES', async () => {
    const send = vi.fn<Send>();
    const sender = new SesWorkspaceInvitationEmailSender(createClient(send), {
      fromAddress: 'invites@onrecord.example.test',
      applicationBaseUrl: 'https://review.example.test/',
    });

    await expect(
      sender.send({
        recipientEmail: 'reviewer@example.test',
        invitationUrl:
          'https://attacker.example.test/#/invitations/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        workspaceDisplayName: 'Engineering',
        role: 'VIEWER',
        expiresAt: new Date('2026-08-14T01:00:00.000Z'),
      }),
    ).rejects.toEqual(
      new WorkspaceInvitationEmailError({
        stage: 'VALIDATION',
        code: 'INVALID_INPUT',
        retryable: false,
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });
});
