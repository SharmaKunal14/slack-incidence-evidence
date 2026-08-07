import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { SecureTokenGenerator } from '../ports/secure-token-generator.js';
import type { SlackIdentityProvider } from '../ports/slack-identity-provider.js';
import type { WorkspaceInvitationEmailSender } from '../ports/workspace-invitation-email-sender.js';
import {
  WorkspaceAccessRepositoryError,
  type WorkspaceAccessRepository,
  type WorkspaceMember,
} from '../ports/workspace-access-repository.js';

const subjectSchema = z.uuid();
const tenantIdSchema = z.string().regex(/^T[A-Z0-9]{1,63}$/u);
const slackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]{1,63}$/u);
const invitationTokenSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const callbackValueSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[\x21-\x7e]+$/u);
const invitationInputSchema = z
  .object({
    tenantId: tenantIdSchema,
    invitedSlackUserId: slackUserIdSchema,
    deliveryEmail: z
      .email()
      .max(320)
      .transform((value) => value.trim().toLowerCase()),
    role: z.enum(['ADMIN', 'REVIEWER', 'VIEWER']),
  })
  .strict();

export type WorkspaceAccessErrorCode =
  | 'FORBIDDEN'
  | 'INVITATION_CONFLICT'
  | 'INVITATION_INVALID'
  | 'IDENTITY_MISMATCH'
  | 'IDENTITY_CONFLICT'
  | 'IDENTITY_PROVIDER_FAILED'
  | 'PERSISTENCE_FAILED';

export class WorkspaceAccessError extends Error {
  public constructor(readonly code: WorkspaceAccessErrorCode) {
    super('Workspace access operation failed');
    this.name = 'WorkspaceAccessError';
  }
}

export class WorkspaceAccessService {
  private readonly applicationBaseUrl: string;
  private readonly slackClientId: string;
  private readonly identityRedirectUri: string;

  public constructor(
    private readonly repository: WorkspaceAccessRepository,
    private readonly tokenGenerator: SecureTokenGenerator,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly invitationEmailSender: WorkspaceInvitationEmailSender,
    configuration: {
      readonly applicationBaseUrl: string;
      readonly slackClientId: string;
      readonly identityRedirectUri: string;
    },
  ) {
    this.applicationBaseUrl = staticHttpsUrl(configuration.applicationBaseUrl);
    this.slackClientId = z
      .string()
      .regex(/^[0-9.]+$/u)
      .parse(configuration.slackClientId);
    this.identityRedirectUri = staticHttpsUrl(
      configuration.identityRedirectUri,
    );
  }

  public async listMembers(
    subject: string,
    tenantId: string,
  ): Promise<readonly WorkspaceMember[]> {
    try {
      return await this.repository.listMembers({
        actorSubject: subjectSchema.parse(subject),
        tenantId: tenantIdSchema.parse(tenantId),
      });
    } catch (error) {
      throw normalizeRepositoryError(error);
    }
  }

  public async invite(
    subject: string,
    input: unknown,
  ): Promise<{
    readonly invitationId: string;
    readonly invitationUrl: string;
    readonly expiresAt: Date;
    readonly emailDeliveryStatus: 'SENT' | 'FAILED';
  }> {
    const parsed = invitationInputSchema.parse(input);
    const token = this.tokenGenerator.generate();
    const createdAt = this.clock.now();
    const expiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1_000);
    try {
      const invitation = await this.repository.createInvitation({
        id: this.idGenerator.generate(),
        actorSubject: subjectSchema.parse(subject),
        ...parsed,
        tokenSha256: sha256(token),
        createdAt,
        expiresAt,
      });
      const invitationUrl = new URL(this.applicationBaseUrl);
      invitationUrl.hash = `/invitations/${token}`;
      let emailDeliveryStatus: 'SENT' | 'FAILED' = 'SENT';
      try {
        await this.invitationEmailSender.send({
          recipientEmail: invitation.deliveryEmail,
          invitationUrl: invitationUrl.toString(),
          workspaceDisplayName: invitation.workspaceDisplayName,
          role: invitation.role,
          expiresAt,
        });
      } catch {
        emailDeliveryStatus = 'FAILED';
      }
      return {
        invitationId: invitation.id,
        invitationUrl: invitationUrl.toString(),
        expiresAt,
        emailDeliveryStatus,
      };
    } catch (error) {
      throw normalizeRepositoryError(error);
    }
  }

  public async updateMember(
    subject: string,
    input: unknown,
  ): Promise<WorkspaceMember> {
    const parsed = z
      .object({
        tenantId: tenantIdSchema,
        memberSubject: subjectSchema,
        role: z.enum(['ADMIN', 'REVIEWER', 'VIEWER']),
        status: z.enum(['ACTIVE', 'REVOKED']),
      })
      .strict()
      .parse(input);
    try {
      return await this.repository.updateMember({
        ...parsed,
        actorSubject: subjectSchema.parse(subject),
        updatedAt: this.clock.now(),
      });
    } catch (error) {
      throw normalizeRepositoryError(error);
    }
  }

  public async startIdentity(
    subject: string,
    invitationToken: string,
  ): Promise<{
    readonly authorizationUrl: string;
    readonly browserBinding: string;
    readonly expiresAt: Date;
  }> {
    const token = invitationTokenSchema.parse(invitationToken);
    const state = this.tokenGenerator.generate();
    const browserBinding = this.tokenGenerator.generate();
    const nonce = this.tokenGenerator.generate();
    const createdAt = this.clock.now();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1_000);
    let tenantId: string;
    try {
      ({ tenantId } = await this.repository.createIdentityAuthorization({
        id: this.idGenerator.generate(),
        tokenSha256: sha256(token),
        cognitoSubject: subjectSchema.parse(subject),
        stateSha256: sha256(state),
        browserBindingSha256: sha256(browserBinding),
        nonceSha256: sha256(nonce),
        redirectUri: this.identityRedirectUri,
        createdAt,
        expiresAt,
      }));
    } catch (error) {
      throw normalizeRepositoryError(error);
    }
    const authorizationUrl = new URL(
      'https://slack.com/openid/connect/authorize',
    );
    authorizationUrl.search = new URLSearchParams({
      client_id: this.slackClientId,
      nonce,
      redirect_uri: this.identityRedirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state,
      team: tenantId,
    }).toString();
    return {
      authorizationUrl: authorizationUrl.toString(),
      browserBinding,
      expiresAt,
    };
  }
}

export class WorkspaceIdentityCompletionService {
  public constructor(
    private readonly repository: WorkspaceAccessRepository,
    private readonly provider: SlackIdentityProvider,
    private readonly clock: Clock,
  ) {}

  public async complete(input: {
    readonly state: string;
    readonly browserBinding: string;
    readonly code: string;
  }): Promise<void> {
    const state = invitationTokenSchema.parse(input.state);
    const browserBinding = invitationTokenSchema.parse(input.browserBinding);
    const code = callbackValueSchema.parse(input.code);
    const authorization = await this.repository.consumeIdentityAuthorization({
      stateSha256: sha256(state),
      browserBindingSha256: sha256(browserBinding),
      consumedAt: this.clock.now(),
    });
    if (authorization === null)
      throw new WorkspaceAccessError('INVITATION_INVALID');
    try {
      const identity = await this.provider.exchangeCode({
        code,
        redirectUri: authorization.redirectUri,
        expectedNonceSha256: authorization.nonceSha256,
      });
      if (
        identity.teamId !== authorization.tenantId ||
        identity.userId !== authorization.invitedSlackUserId
      ) {
        throw new WorkspaceAccessError('IDENTITY_MISMATCH');
      }
      await this.repository.completeIdentityAuthorization({
        authorizationId: authorization.authorizationId,
        invitationId: authorization.invitationId,
        cognitoSubject: authorization.cognitoSubject,
        teamId: identity.teamId,
        slackUserId: identity.userId,
        role: authorization.role,
        completedAt: this.clock.now(),
      });
    } catch (error) {
      const normalized =
        error instanceof WorkspaceAccessError
          ? error
          : new WorkspaceAccessError('IDENTITY_PROVIDER_FAILED');
      await this.repository
        .failIdentityAuthorization({
          authorizationId: authorization.authorizationId,
          failureCode: normalized.code,
          failedAt: this.clock.now(),
        })
        .catch(() => undefined);
      throw normalized;
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function staticHttpsUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Workspace access URL must be a static HTTPS URL');
  }
  return url.toString();
}
function normalizeRepositoryError(error: unknown): WorkspaceAccessError {
  if (error instanceof WorkspaceAccessRepositoryError) {
    if (error.code === 'FORBIDDEN')
      return new WorkspaceAccessError('FORBIDDEN');
    if (error.code === 'INVITATION_CONFLICT')
      return new WorkspaceAccessError('INVITATION_CONFLICT');
    if (error.code === 'IDENTITY_CONFLICT')
      return new WorkspaceAccessError('IDENTITY_CONFLICT');
    return new WorkspaceAccessError('INVITATION_INVALID');
  }
  return new WorkspaceAccessError('PERSISTENCE_FAILED');
}
