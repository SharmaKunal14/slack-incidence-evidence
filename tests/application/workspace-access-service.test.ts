import { describe, expect, it, vi } from 'vitest';
import { WorkspaceAccessService } from '../../src/application/onboarding/workspace-access-service.js';
import type { WorkspaceAccessRepository } from '../../src/application/ports/workspace-access-repository.js';

const subject = '9f218e92-36a8-455d-869c-a76e27b399df';
const invitationId = '617b5728-8404-4934-a616-1a319ba72b7f';
const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const now = new Date('2026-08-07T01:00:00.000Z');

describe('WorkspaceAccessService invitation email delivery', () => {
  it('emails the durable single-use invitation after authorization succeeds', async () => {
    const send = vi.fn().mockResolvedValue({ providerMessageId: 'message-1' });
    const service = createService(send);

    await expect(
      service.invite(subject, {
        tenantId: 'T001',
        invitedSlackUserId: 'U001',
        deliveryEmail: 'Reviewer@Example.test',
        role: 'REVIEWER',
      }),
    ).resolves.toMatchObject({
      invitationId,
      emailDeliveryStatus: 'SENT',
    });

    expect(send).toHaveBeenCalledWith({
      recipientEmail: 'reviewer@example.test',
      invitationUrl: `https://review.example.test/#/invitations/${token}`,
      workspaceDisplayName: 'Engineering',
      role: 'REVIEWER',
      expiresAt: new Date('2026-08-14T01:00:00.000Z'),
    });
  });

  it('keeps the invitation usable and exposes a copy-link fallback when SES fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('SES unavailable'));
    const service = createService(send);

    await expect(
      service.invite(subject, {
        tenantId: 'T001',
        invitedSlackUserId: 'U001',
        deliveryEmail: 'reviewer@example.test',
        role: 'VIEWER',
      }),
    ).resolves.toMatchObject({
      invitationId,
      invitationUrl: `https://review.example.test/#/invitations/${token}`,
      emailDeliveryStatus: 'FAILED',
    });
  });
});

function createService(send: ReturnType<typeof vi.fn>): WorkspaceAccessService {
  const repository = {
    createInvitation: vi.fn().mockResolvedValue({
      id: invitationId,
      tenantId: 'T001',
      workspaceDisplayName: 'Engineering',
      invitedSlackUserId: 'U001',
      deliveryEmail: 'reviewer@example.test',
      role: 'REVIEWER',
      status: 'PENDING',
      expiresAt: new Date('2026-08-14T01:00:00.000Z'),
      createdAt: now,
    }),
  } as unknown as WorkspaceAccessRepository;
  return new WorkspaceAccessService(
    repository,
    { generate: () => token },
    { generate: () => invitationId },
    { now: () => now },
    { send },
    {
      applicationBaseUrl: 'https://review.example.test/',
      slackClientId: '123.456',
      identityRedirectUri:
        'https://review.example.test/onboarding/slack/identity/callback',
    },
  );
}
