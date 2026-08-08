import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import pino from 'pino';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ReviewConflictError } from '../../src/application/review/incident-review.js';
import { WorkspaceAccessError } from '../../src/application/onboarding/workspace-access-service.js';
import {
  createIncidentReviewApiHandler,
  type IncidentReviewApiDependencies,
} from '../../src/lambda/incident-review-api-handler.js';

const incidentId = '2c6a2f4a-f762-41e9-9620-a07abdaa5c48';
const revisionId = '617b5728-8404-4934-a616-1a319ba72b7f';
const subject = '9f218e92-36a8-455d-869c-a76e27b399df';

function dependencies(
  overrides: Partial<IncidentReviewApiDependencies> = {},
): IncidentReviewApiDependencies {
  return {
    listReviews: {
      execute: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    },
    getReview: {
      execute: vi.fn().mockResolvedValue({ incident: { id: incidentId } }),
    },
    getRevision: {
      execute: vi.fn().mockResolvedValue({
        id: revisionId,
        revisionNumber: 1,
        status: 'DRAFT',
        createdAt: '2026-07-18T01:00:00.000Z',
        statementCount: 1,
        acknowledgedContradictions: true,
        acknowledgedOpenQuestions: true,
        statements: [],
      }),
    },
    createRevision: {
      execute: vi.fn().mockResolvedValue({
        id: revisionId,
        createdAt: new Date('2026-07-18T01:00:00.000Z'),
        approvedAt: null,
      }),
    },
    approveRevision: {
      execute: vi.fn().mockResolvedValue({
        id: revisionId,
        createdAt: new Date('2026-07-18T01:00:00.000Z'),
        approvedAt: new Date('2026-07-18T01:05:00.000Z'),
      }),
    },
    assignReviewer: {
      execute: vi.fn().mockResolvedValue({
        incidentId,
        workspaceId: 'T001',
        assignedMemberSubject: subject,
        assignedSlackUserId: 'U001',
        incidentVersion: 5,
        updatedAt: '2026-07-18T01:05:00.000Z',
      }),
    },
    getSlackOnboardingStatus: {
      execute: vi.fn().mockResolvedValue({
        canStartInstallation: true,
        workspaces: [],
      }),
    },
    workspaceAccess: {
      listMembers: vi.fn().mockResolvedValue([]),
      invite: vi.fn(),
      updateMember: vi.fn(),
      startIdentity: vi.fn(),
    },
    logger: pino({ level: 'silent' }),
    maxBodyBytes: 524_288,
    ...overrides,
  };
}

function eventFor(input: {
  readonly routeKey: string;
  readonly path?: string;
  readonly pathParameters?: Record<string, string>;
  readonly body?: string;
  readonly tokenUse?: string;
  readonly subject?: string;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: '2.0',
    routeKey: input.routeKey,
    rawPath: input.path ?? '/review/incidents',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: {
        integrationLatency: 0,
        jwt: {
          claims: {
            sub: input.subject ?? subject,
            token_use: input.tokenUse ?? 'access',
          },
          scopes: [],
        },
        principalId: subject,
      },
      domainName: 'example.execute-api.ap-southeast-2.amazonaws.com',
      domainPrefix: 'example',
      http: {
        method: input.routeKey.split(' ')[0] ?? 'GET',
        path: input.path ?? '/review/incidents',
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.1',
        userAgent: 'test',
      },
      requestId: 'request-id',
      routeKey: input.routeKey,
      stage: '$default',
      time: '18/Jul/2026:01:00:00 +0000',
      timeEpoch: 1_784_336_400_000,
    },
    ...(input.pathParameters === undefined
      ? {}
      : { pathParameters: input.pathParameters }),
    ...(input.body === undefined ? {} : { body: input.body }),
    isBase64Encoded: false,
  };
}

function structured(
  response: APIGatewayProxyResultV2,
): APIGatewayProxyStructuredResultV2 {
  if (typeof response === 'string') {
    throw new Error('Expected structured API response');
  }
  return response;
}

function parsed(response: APIGatewayProxyResultV2): unknown {
  return JSON.parse(structured(response).body ?? '') as unknown;
}

describe('incident review API boundary', () => {
  it('accepts bounded opaque Cognito subjects only from access tokens', async () => {
    const deps = dependencies();
    const handler = createIncidentReviewApiHandler(deps);
    const nonRfcUuidSubject = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    const idTokenResponse = await handler(
      eventFor({ routeKey: 'GET /review/incidents', tokenUse: 'id' }),
    );
    const invalidSubjectResponse = await handler(
      eventFor({
        routeKey: 'GET /review/incidents',
        subject: 's'.repeat(129),
      }),
    );
    const opaqueSubjectResponse = await handler(
      eventFor({
        routeKey: 'GET /review/incidents',
        subject: nonRfcUuidSubject,
      }),
    );

    expect(structured(idTokenResponse).statusCode).toBe(401);
    expect(structured(invalidSubjectResponse).statusCode).toBe(401);
    expect(structured(opaqueSubjectResponse).statusCode).toBe(200);
    expect(deps.listReviews.execute).toHaveBeenCalledOnce();
    expect(deps.listReviews.execute).toHaveBeenCalledWith({
      reviewer: { subject: nonRfcUuidSubject },
      limit: 20,
      cursor: null,
    });
  });

  it('uses the JWT subject for server-side review authorization', async () => {
    const deps = dependencies();
    const handler = createIncidentReviewApiHandler(deps);

    const response = await handler(
      eventFor({ routeKey: 'GET /review/incidents' }),
    );

    expect(structured(response).statusCode).toBe(200);
    expect(deps.listReviews.execute).toHaveBeenCalledWith({
      reviewer: { subject },
      limit: 20,
      cursor: null,
    });
    expect(structured(response).headers).toMatchObject({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
  });

  it('returns only safe, membership-scoped Slack connection metadata', async () => {
    const getSlackOnboardingStatus = vi.fn().mockResolvedValue({
      canStartInstallation: true,
      workspaces: [
        {
          workspaceId: 'T001',
          displayName: 'Acme Engineering',
          role: 'ADMIN',
          connectionStatus: 'CONNECTED',
          canManage: true,
          installedAt: new Date('2026-08-05T01:00:00.000Z'),
          updatedAt: new Date('2026-08-05T01:05:00.000Z'),
          credentialExpiresAt: null,
        },
      ],
    });
    const handler = createIncidentReviewApiHandler(
      dependencies({
        getSlackOnboardingStatus: { execute: getSlackOnboardingStatus },
      }),
    );

    const response = await handler(
      eventFor({ routeKey: 'GET /review/onboarding/slack/status' }),
    );

    expect(structured(response).statusCode).toBe(200);
    expect(getSlackOnboardingStatus).toHaveBeenCalledWith(subject);
    expect(parsed(response)).toEqual({
      canStartInstallation: true,
      workspaces: [
        {
          workspaceId: 'T001',
          displayName: 'Acme Engineering',
          role: 'ADMIN',
          connectionStatus: 'CONNECTED',
          canManage: true,
          installedAt: '2026-08-05T01:00:00.000Z',
          updatedAt: '2026-08-05T01:05:00.000Z',
          credentialExpiresAt: null,
        },
      ],
    });
    expect(structured(response).body).not.toContain('secret');
    expect(structured(response).body).not.toContain('token');
  });

  it('creates a role invitation from the authenticated workspace manager', async () => {
    const invite = vi.fn().mockResolvedValue({
      invitationId: '617b5728-8404-4934-a616-1a319ba72b7f',
      invitationUrl:
        'https://app.example.test/#/invitations/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      expiresAt: new Date('2026-08-14T01:00:00.000Z'),
      emailDeliveryStatus: 'SENT',
    });
    const handler = createIncidentReviewApiHandler(
      dependencies({
        workspaceAccess: { ...dependencies().workspaceAccess, invite },
      }),
    );
    const response = await handler(
      eventFor({
        routeKey: 'POST /review/workspaces/{workspaceId}/invitations',
        pathParameters: { workspaceId: 'T001' },
        body: JSON.stringify({
          invitedSlackUserId: 'U001',
          deliveryEmail: 'person@example.test',
          role: 'REVIEWER',
        }),
      }),
    );
    expect(structured(response).statusCode).toBe(201);
    expect(invite).toHaveBeenCalledWith(subject, {
      tenantId: 'T001',
      invitedSlackUserId: 'U001',
      deliveryEmail: 'person@example.test',
      role: 'REVIEWER',
    });
  });

  it('logs only bounded email diagnostics and keeps them out of the response', async () => {
    const warn = vi.fn();
    const invitationToken =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ-secret-token';
    const invite = vi.fn().mockResolvedValue({
      invitationId: '617b5728-8404-4934-a616-1a319ba72b7f',
      invitationUrl: `https://app.example.test/#/invitations/${invitationToken}`,
      expiresAt: new Date('2026-08-14T01:00:00.000Z'),
      emailDeliveryStatus: 'FAILED',
      emailDeliveryFailure: {
        stage: 'REQUEST',
        code: 'PROVIDER_REJECTED',
        retryable: false,
        providerCode: 'AccessDeniedException',
        providerRequestId: 'safe-request-id',
        httpStatusCode: 403,
      },
    });
    const handler = createIncidentReviewApiHandler(
      dependencies({
        workspaceAccess: { ...dependencies().workspaceAccess, invite },
        logger: { warn } as unknown as Logger,
      }),
    );

    const response = await handler(
      eventFor({
        routeKey: 'POST /review/workspaces/{workspaceId}/invitations',
        pathParameters: { workspaceId: 'T001' },
        body: JSON.stringify({
          invitedSlackUserId: 'U001',
          deliveryEmail: 'person@example.test',
          role: 'REVIEWER',
        }),
      }),
    );

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryFailureStage: 'REQUEST',
        deliveryFailureCode: 'PROVIDER_REJECTED',
        deliveryRetryable: false,
        providerCode: 'AccessDeniedException',
        providerRequestId: 'safe-request-id',
        providerHttpStatusCode: 403,
      }),
      'Workspace invitation created but email delivery failed',
    );
    expect(parsed(response)).toEqual({
      invitationId: '617b5728-8404-4934-a616-1a319ba72b7f',
      invitationUrl: `https://app.example.test/#/invitations/${invitationToken}`,
      expiresAt: '2026-08-14T01:00:00.000Z',
      emailDeliveryStatus: 'FAILED',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      'person@example.test',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(invitationToken);
  });

  it('does not expose workspace membership operations to non-managers', async () => {
    const listMembers = vi
      .fn()
      .mockRejectedValue(new WorkspaceAccessError('FORBIDDEN'));
    const handler = createIncidentReviewApiHandler(
      dependencies({
        workspaceAccess: { ...dependencies().workspaceAccess, listMembers },
      }),
    );
    const response = await handler(
      eventFor({
        routeKey: 'GET /review/workspaces/{workspaceId}/members',
        pathParameters: { workspaceId: 'T001' },
      }),
    );
    expect(structured(response).statusCode).toBe(403);
    expect(parsed(response)).toEqual({ error: 'forbidden' });
  });

  it('loads one preserved revision through the tenant-authorized use case', async () => {
    const deps = dependencies();
    const handler = createIncidentReviewApiHandler(deps);

    const response = await handler(
      eventFor({
        routeKey: 'GET /review/incidents/{incidentId}/revisions/{revisionId}',
        pathParameters: { incidentId, revisionId },
      }),
    );

    expect(structured(response).statusCode).toBe(200);
    expect(deps.getRevision.execute).toHaveBeenCalledWith({
      reviewer: { subject },
      incidentId,
      revisionId,
    });
  });

  it('passes reviewer assignment through the authenticated use case', async () => {
    const deps = dependencies();
    const handler = createIncidentReviewApiHandler(deps);
    const command = {
      expectedIncidentVersion: 4,
      memberSubject: subject,
      clientRequestId: 'd61ad8d8-5111-4ce0-a044-1addc5bf0414',
    };

    const response = await handler(
      eventFor({
        routeKey: 'PATCH /review/incidents/{incidentId}/assignment',
        pathParameters: { incidentId },
        body: JSON.stringify(command),
      }),
    );

    expect(structured(response).statusCode).toBe(200);
    expect(deps.assignReviewer.execute).toHaveBeenCalledWith({
      reviewer: { subject },
      incidentId,
      command,
    });
  });

  it('rejects mismatched path and body IDs before mutation', async () => {
    const deps = dependencies();
    const handler = createIncidentReviewApiHandler(deps);
    const otherIncident = '939d3fc4-9557-4d7b-aada-bc2d28e096bf';

    const response = await handler(
      eventFor({
        routeKey: 'POST /review/incidents/{incidentId}/revisions',
        pathParameters: { incidentId },
        body: JSON.stringify({
          incidentId: otherIncident,
          reportDraftId: '7df1bcac-5583-4cd6-91db-981989f4c482',
          expectedIncidentVersion: 4,
          clientRequestId: 'd61ad8d8-5111-4ce0-a044-1addc5bf0414',
          acknowledgedContradictions: true,
          acknowledgedOpenQuestions: true,
          decisions: [{ statementId: 'statement-1', decision: 'KEEP' }],
        }),
      }),
    );

    expect(structured(response).statusCode).toBe(400);
    expect(parsed(response)).toEqual({ error: 'invalid_request' });
    expect(deps.createRevision.execute).not.toHaveBeenCalled();
  });

  it('returns a stable conflict without exposing internal error details', async () => {
    const deps = dependencies({
      approveRevision: {
        execute: vi
          .fn()
          .mockRejectedValue(new ReviewConflictError('private database state')),
      },
    });
    const handler = createIncidentReviewApiHandler(deps);

    const response = await handler(
      eventFor({
        routeKey:
          'POST /review/incidents/{incidentId}/revisions/{revisionId}/approve',
        pathParameters: { incidentId, revisionId },
        body: JSON.stringify({
          incidentId,
          revisionId,
          expectedIncidentVersion: 4,
          clientRequestId: 'd61ad8d8-5111-4ce0-a044-1addc5bf0414',
        }),
      }),
    );

    expect(structured(response).statusCode).toBe(409);
    expect(parsed(response)).toEqual({ error: 'review_conflict' });
    expect(structured(response).body).not.toContain('private database state');
  });

  it('rejects oversized JSON bodies without parsing or mutation', async () => {
    const deps = dependencies({ maxBodyBytes: 1_024 });
    const handler = createIncidentReviewApiHandler(deps);

    const response = await handler(
      eventFor({
        routeKey: 'POST /review/incidents/{incidentId}/revisions',
        pathParameters: { incidentId },
        body: JSON.stringify({ payload: 'x'.repeat(2_000) }),
      }),
    );

    expect(structured(response).statusCode).toBe(400);
    expect(deps.createRevision.execute).not.toHaveBeenCalled();
  });
});
