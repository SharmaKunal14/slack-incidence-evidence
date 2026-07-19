import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import type { Logger } from 'pino';
import { z } from 'zod';
import type {
  ApproveReportRevision,
  CreateReportRevision,
  GetIncidentReview,
  GetReportRevision,
  ListIncidentReviews,
} from '../application/review-incident.js';
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

const subjectSchema = z.uuid();
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

function authenticatedReviewer(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): ReviewerIdentity | null {
  const claims = event.requestContext.authorizer.jwt.claims;
  if (claims['token_use'] !== 'access') {
    return null;
  }
  const subject = subjectSchema.safeParse(claims['sub']);
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
): APIGatewayProxyResultV2 {
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
