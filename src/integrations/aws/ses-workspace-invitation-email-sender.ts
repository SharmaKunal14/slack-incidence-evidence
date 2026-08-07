import {
  SendEmailCommand,
  SESv2ServiceException,
  type SESv2Client,
} from '@aws-sdk/client-sesv2';
import { z } from 'zod';
import {
  WorkspaceInvitationEmailError,
  type WorkspaceInvitationEmailSender,
} from '../../application/ports/workspace-invitation-email-sender.js';

const emailSchema = z.email().max(320);
const roleSchema = z.enum(['ADMIN', 'REVIEWER', 'VIEWER']);

export class SesWorkspaceInvitationEmailSender implements WorkspaceInvitationEmailSender {
  private readonly fromAddress: string;
  private readonly applicationOrigin: string;

  public constructor(
    private readonly client: SESv2Client,
    configuration: {
      readonly fromAddress: string;
      readonly applicationBaseUrl: string;
    },
  ) {
    this.fromAddress = emailSchema.parse(configuration.fromAddress);
    this.applicationOrigin = new URL(
      z.url().parse(configuration.applicationBaseUrl),
    ).origin;
  }

  public async send(
    input: Parameters<WorkspaceInvitationEmailSender['send']>[0],
  ): Promise<{ readonly providerMessageId: string }> {
    const recipient = emailSchema.parse(input.recipientEmail);
    const role = roleSchema.parse(input.role);
    const invitationUrl = requireOnRecordHttpsUrl(
      input.invitationUrl,
      this.applicationOrigin,
    );
    const workspaceName = z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n]/u.test(value))
      .parse(input.workspaceDisplayName);
    const expiresAt = z.date().parse(input.expiresAt);
    const subject = `You are invited to ${workspaceName} on OnRecord`;
    const text = [
      `You have been invited to join ${workspaceName} on OnRecord as ${humanRole(role)}.`,
      '',
      'Sign in to your separate OnRecord account, then use Slack to verify the exact workspace and user identity named by the invitation.',
      '',
      `Accept invitation: ${invitationUrl}`,
      `This single-use invitation expires ${expiresAt.toISOString()}.`,
      '',
      'OnRecord will never ask for your Slack password. If you were not expecting this invitation, ignore this email.',
    ].join('\n');
    const html = renderHtml({ invitationUrl, workspaceName, role, expiresAt });

    try {
      const output = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.fromAddress,
          Destination: { ToAddresses: [recipient] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: text, Charset: 'UTF-8' },
                Html: { Data: html, Charset: 'UTF-8' },
              },
            },
          },
        }),
        { abortSignal: AbortSignal.timeout(5_000) },
      );
      if (output.MessageId === undefined || output.MessageId.length === 0) {
        throw new WorkspaceInvitationEmailError(false);
      }
      return { providerMessageId: output.MessageId };
    } catch (error) {
      if (error instanceof WorkspaceInvitationEmailError) throw error;
      throw new WorkspaceInvitationEmailError(isRetryable(error));
    }
  }
}

function renderHtml(input: {
  readonly invitationUrl: string;
  readonly workspaceName: string;
  readonly role: 'ADMIN' | 'REVIEWER' | 'VIEWER';
  readonly expiresAt: Date;
}): string {
  const workspaceName = escapeHtml(input.workspaceName);
  const invitationUrl = escapeHtml(input.invitationUrl);
  return `<!doctype html><html lang="en"><body style="font-family:Arial,sans-serif;color:#172033;line-height:1.6"><h1>Join ${workspaceName} on OnRecord</h1><p>You have been invited as <strong>${humanRole(input.role)}</strong>.</p><p>Sign in to your separate OnRecord account, then use Slack to verify the exact invited workspace and user.</p><p><a href="${invitationUrl}" style="display:inline-block;background:#4f5de4;color:#fff;padding:12px 18px;text-decoration:none;border-radius:8px">Accept invitation</a></p><p>This single-use invitation expires ${escapeHtml(input.expiresAt.toISOString())}.</p><p><strong>OnRecord will never ask for your Slack password.</strong></p><p>If you were not expecting this invitation, ignore this email.</p></body></html>`;
}

function requireOnRecordHttpsUrl(
  value: string,
  expectedOrigin: string,
): string {
  const url = new URL(z.url().max(4_096).parse(value));
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.origin !== expectedOrigin ||
    !url.hash.startsWith('#/invitations/')
  ) {
    throw new WorkspaceInvitationEmailError(false);
  }
  return url.toString();
}

function humanRole(role: 'ADMIN' | 'REVIEWER' | 'VIEWER'): string {
  return role === 'ADMIN'
    ? 'Administrator'
    : role === 'REVIEWER'
      ? 'Reviewer'
      : 'Viewer';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof SESv2ServiceException &&
    (error.$retryable !== undefined ||
      error.$metadata.httpStatusCode === 429 ||
      (error.$metadata.httpStatusCode ?? 0) >= 500)
  );
}
