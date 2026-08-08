import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { Logger } from 'pino';
import { z } from 'zod';
import { cognitoSubjectSchema } from '../application/identity/cognito-subject.js';
import type {
  ApproveReportRevision,
  AssignIncidentReviewer,
  CreateReportRevision,
  GetIncidentReview,
  GetReportRevision,
  ListIncidentReviews,
} from '../application/review-incident.js';
import type { GetSlackOnboardingStatus } from '../application/get-slack-onboarding-status.js';
import {
  WorkspaceAccessError,
  type WorkspaceAccessService,
} from '../application/onboarding/workspace-access-service.js';
import {
  approveReportRevisionCommandSchema,
  createReportRevisionCommandSchema,
  ReviewAuthorizationError,
  ReviewConflictError,
  ReviewNotFoundError,
  ReviewValidationError,
  type ReviewInboxCursor,
  type ReviewerIdentity,
} from '../application/review/incident-review.js';

const incidentIdSchema = z.uuid();
const cursorSchema = z
  .object({
    createdAt: z.iso.datetime(),
    incidentId: z.uuid(),
  })
  .strict();

export interface IncidentReviewApiDependencies {
  readonly listReviews: Pick<ListIncidentReviews, 'execute'>;
  readonly getReview: Pick<GetIncidentReview, 'execute'>;
  readonly getRevision: Pick<GetReportRevision, 'execute'>;
  readonly createRevision: Pick<CreateReportRevision, 'execute'>;
  readonly approveRevision: Pick<ApproveReportRevision, 'execute'>;
  readonly assignReviewer: Pick<AssignIncidentReviewer, 'execute'>;
  readonly getSlackOnboardingStatus: Pick<GetSlackOnboardingStatus, 'execute'>;
  readonly workspaceAccess: Pick<
    WorkspaceAccessService,
    'listMembers' | 'invite' | 'updateMember' | 'startIdentity'
  >;
  readonly logger: Logger;
  readonly maxBodyBytes: number;
}

export type IncidentReviewApiHandler = (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => Promise<APIGatewayProxyResultV2>;

export function createIncidentReviewApiHandler(
  dependencies: IncidentReviewApiDependencies,
): IncidentReviewApiHandler {
  return async (event) => {
    const reviewer = authenticatedReviewer(event);
    if (reviewer === null) {
      return jsonResponse(401, { error: 'unauthorized' });
    }
    try {
      switch (event.routeKey) {
        case 'GET /review/workspaces/{workspaceId}/members': {
          const workspaceId = parseWorkspaceId(event);
          const members = await dependencies.workspaceAccess.listMembers(
            reviewer.subject,
            workspaceId,
          );
          return jsonResponse(200, {
            members: members.map((member) => ({
              ...member,
              createdAt: member.createdAt.toISOString(),
              updatedAt: member.updatedAt.toISOString(),
            })),
          });
        }
        case 'POST /review/workspaces/{workspaceId}/invitations': {
          const workspaceId = parseWorkspaceId(event);
          const body = parseJsonBody(event, dependencies.maxBodyBytes);
          const invitation = await dependencies.workspaceAccess.invite(
            reviewer.subject,
            { ...(isRecord(body) ? body : {}), tenantId: workspaceId },
          );
          if (invitation.emailDeliveryStatus === 'FAILED') {
            dependencies.logger.warn(
              {
                requestId: event.requestContext.requestId,
                invitationId: invitation.invitationId,
                workspaceId,
                deliveryFailureStage:
                  invitation.emailDeliveryFailure?.stage ?? 'REQUEST',
                deliveryFailureCode:
                  invitation.emailDeliveryFailure?.code ?? 'REQUEST_FAILED',
                deliveryRetryable:
                  invitation.emailDeliveryFailure?.retryable ?? false,
                providerCode: invitation.emailDeliveryFailure?.providerCode,
                providerRequestId:
                  invitation.emailDeliveryFailure?.providerRequestId,
                providerHttpStatusCode:
                  invitation.emailDeliveryFailure?.httpStatusCode,
              },
              'Workspace invitation created but email delivery failed',
            );
          }
          return jsonResponse(201, {
            invitationId: invitation.invitationId,
            invitationUrl: invitation.invitationUrl,
            expiresAt: invitation.expiresAt.toISOString(),
            emailDeliveryStatus: invitation.emailDeliveryStatus,
          });
        }
        case 'PATCH /review/workspaces/{workspaceId}/members/{memberSubject}': {
          const workspaceId = parseWorkspaceId(event);
          const memberSubject = cognitoSubjectSchema.parse(
            event.pathParameters?.['memberSubject'],
          );
          const body = parseJsonBody(event, dependencies.maxBodyBytes);
          const member = await dependencies.workspaceAccess.updateMember(
            reviewer.subject,
            {
              ...(isRecord(body) ? body : {}),
              tenantId: workspaceId,
              memberSubject,
            },
          );
          return jsonResponse(200, {
            ...member,
            createdAt: member.createdAt.toISOString(),
            updatedAt: member.updatedAt.toISOString(),
          });
        }
        case 'POST /review/invitations/slack/start': {
          const body = z
            .object({ invitationToken: z.string().min(43).max(128) })
            .strict()
            .parse(parseJsonBody(event, dependencies.maxBodyBytes));
          const started = await dependencies.workspaceAccess.startIdentity(
            reviewer.subject,
            body.invitationToken,
          );
          return {
            ...jsonResponse(200, {
              authorizationUrl: started.authorizationUrl,
              expiresAt: started.expiresAt.toISOString(),
            }),
            cookies: [
              `__Host-onrecord-slack-identity=${started.browserBinding}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`,
            ],
          };
        }
        case 'GET /review/onboarding/slack/status': {
          const status = await dependencies.getSlackOnboardingStatus.execute(
            reviewer.subject,
          );
          return jsonResponse(200, {
            canStartInstallation: status.canStartInstallation,
            workspaces: status.workspaces.map((workspace) => ({
              ...workspace,
              installedAt: workspace.installedAt?.toISOString() ?? null,
              updatedAt: workspace.updatedAt.toISOString(),
              credentialExpiresAt:
                workspace.credentialExpiresAt?.toISOString() ?? null,
            })),
          });
        }
        case 'GET /review/incidents': {
          const limit = parseLimit(event.queryStringParameters?.['limit']);
          const cursor = parseCursor(event.queryStringParameters?.['cursor']);
          const page = await dependencies.listReviews.execute({
            reviewer,
            limit,
            cursor,
          });
          return jsonResponse(200, {
            items: page.items,
            nextCursor:
              page.nextCursor === null ? null : encodeCursor(page.nextCursor),
          });
        }
        case 'GET /review/incidents/{incidentId}': {
          const incidentId = parsePathId(event, 'incidentId');
          const bundle = await dependencies.getReview.execute({
            reviewer,
            incidentId,
          });
          return jsonResponse(200, bundle);
        }
        case 'PATCH /review/incidents/{incidentId}/assignment': {
          const incidentId = parsePathId(event, 'incidentId');
          const assignment = await dependencies.assignReviewer.execute({
            reviewer,
            incidentId,
            command: parseJsonBody(event, dependencies.maxBodyBytes),
          });
          return jsonResponse(200, { assignment });
        }
        case 'GET /review/incidents/{incidentId}/revisions/{revisionId}': {
          const incidentId = parsePathId(event, 'incidentId');
          const revisionId = parsePathId(event, 'revisionId');
          const revision = await dependencies.getRevision.execute({
            reviewer,
            incidentId,
            revisionId,
          });
          return jsonResponse(200, { revision });
        }
        case 'POST /review/incidents/{incidentId}/revisions': {
          const incidentId = parsePathId(event, 'incidentId');
          const body = createReportRevisionCommandSchema.parse(
            parseJsonBody(event, dependencies.maxBodyBytes),
          );
          if (body.incidentId !== incidentId) {
            throw new ReviewValidationError(
              'Path and body incident identifiers do not match',
            );
          }
          const revision = await dependencies.createRevision.execute({
            reviewer,
            command: body,
          });
          return jsonResponse(201, { revision: serializeRevision(revision) });
        }
        case 'POST /review/incidents/{incidentId}/revisions/{revisionId}/approve': {
          const incidentId = parsePathId(event, 'incidentId');
          const revisionId = parsePathId(event, 'revisionId');
          const body = approveReportRevisionCommandSchema.parse(
            parseJsonBody(event, dependencies.maxBodyBytes),
          );
          if (
            body.incidentId !== incidentId ||
            body.revisionId !== revisionId
          ) {
            throw new ReviewValidationError(
              'Path and body review identifiers do not match',
            );
          }
          const revision = await dependencies.approveRevision.execute({
            reviewer,
            command: body,
          });
          return jsonResponse(200, { revision: serializeRevision(revision) });
        }
        default:
          return jsonResponse(404, { error: 'not_found' });
      }
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
        if (error.code === 'FORBIDDEN') {
          return jsonResponse(403, { error: 'forbidden' });
        }
        if (
          error.code === 'INVITATION_CONFLICT' ||
          error.code === 'IDENTITY_CONFLICT'
        ) {
          return jsonResponse(409, { error: error.code.toLowerCase() });
        }
        if (error.code === 'INVITATION_INVALID') {
          return jsonResponse(400, { error: 'invitation_invalid' });
        }
      }
      if (error instanceof ReviewAuthorizationError) {
        return jsonResponse(403, { error: 'forbidden' });
      }
      if (error instanceof ReviewNotFoundError) {
        return jsonResponse(404, { error: 'not_found' });
      }
      if (error instanceof ReviewConflictError) {
        return jsonResponse(409, { error: 'review_conflict' });
      }
      if (
        error instanceof ReviewValidationError ||
        error instanceof z.ZodError
      ) {
        return jsonResponse(400, { error: 'invalid_request' });
      }
      dependencies.logger.error(
        {
          requestId: event.requestContext.requestId,
          routeKey: event.routeKey,
        },
        'Incident review API request failed',
      );
      return jsonResponse(500, { error: 'internal_server_error' });
    }
  };
}

function parseWorkspaceId(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): string {
  return z
    .string()
    .regex(/^T[A-Z0-9]{1,63}$/u)
    .parse(event.pathParameters?.['workspaceId']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authenticatedReviewer(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): ReviewerIdentity | null {
  const claims = event.requestContext.authorizer.jwt.claims;
  if (claims['token_use'] !== 'access') {
    return null;
  }
  const subject = cognitoSubjectSchema.safeParse(claims['sub']);
  return subject.success ? { subject: subject.data } : null;
}

function parsePathId(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  name: string,
): string {
  return incidentIdSchema.parse(event.pathParameters?.[name]);
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) {
    return 20;
  }
  if (!/^\d{1,2}$/u.test(value)) {
    throw new ReviewValidationError('Invalid review page limit');
  }
  const limit = Number(value);
  if (limit < 1 || limit > 50) {
    throw new ReviewValidationError('Invalid review page limit');
  }
  return limit;
}

function parseCursor(value: string | undefined): ReviewInboxCursor | null {
  if (value === undefined) {
    return null;
  }
  if (
    value.length < 1 ||
    value.length > 1_024 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new ReviewValidationError('Invalid review cursor');
  }
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown,
    );
  } catch {
    throw new ReviewValidationError('Invalid review cursor');
  }
}

function encodeCursor(cursor: ReviewInboxCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function parseJsonBody(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  maximumBytes: number,
): unknown {
  const body = Buffer.from(
    event.body ?? '',
    event.isBase64Encoded ? 'base64' : 'utf8',
  );
  if (body.byteLength === 0 || body.byteLength > maximumBytes) {
    throw new ReviewValidationError('Invalid review request body size');
  }
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new ReviewValidationError('Invalid review request JSON');
  }
}

function serializeRevision(
  revision: Awaited<ReturnType<ApproveReportRevision['execute']>>,
): Readonly<Record<string, unknown>> {
  return {
    ...revision,
    createdAt: revision.createdAt.toISOString(),
    approvedAt: revision.approvedAt?.toISOString() ?? null,
  };
}

function jsonResponse(
  statusCode: number,
  body: unknown,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}
