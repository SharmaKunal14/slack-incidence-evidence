import { describe, expect, it } from 'vitest';
import { ApiError } from '../../web/src/auth.js';
import {
  createDemoReviewApi,
  demoConfiguration,
  demoIncidentId,
} from '../../web/src/demo-review-api.js';
import { bundleSchema, inboxSchema } from '../../web/src/contracts.js';

const token = 'synthetic-demo';

interface RevisionRequest {
  readonly incidentId: string;
  readonly reportDraftId: string;
  readonly expectedIncidentVersion: number;
  readonly clientRequestId: string;
  readonly acknowledgedContradictions: boolean;
  readonly acknowledgedOpenQuestions: boolean;
  readonly questionAnswers: readonly {
    readonly questionId: string;
    readonly answer: string;
  }[];
  readonly additionalStatements: readonly never[];
  readonly decisions: readonly {
    readonly statementId: string;
    readonly decision: 'KEEP';
  }[];
}

describe('synthetic review API', () => {
  it('serves a schema-valid incident without external I/O', async () => {
    const api = createDemoReviewApi();
    const inbox = inboxSchema.parse(
      await api(demoConfiguration, token, '/review/incidents?limit=50'),
    );
    const bundle = bundleSchema.parse(
      await api(
        demoConfiguration,
        token,
        `/review/incidents/${demoIncidentId}`,
      ),
    );

    expect(inbox.items).toHaveLength(1);
    expect(bundle.incident.title).toBe('EU checkout outage');
    expect(bundle.latestRevision).toBeNull();
    expect(bundle.evidenceCoverage).toHaveLength(3);
  });

  it('rejects invalid credentials, routes, and incomplete decisions', async () => {
    const api = createDemoReviewApi();

    await expect(
      api(demoConfiguration, 'wrong-token', '/review/incidents'),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      api(demoConfiguration, token, '/not-a-demo-route'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      api(
        demoConfiguration,
        token,
        `/review/incidents/${demoIncidentId}/revisions`,
        {
          method: 'POST',
          body: JSON.stringify(revisionRequest([])),
        },
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('preserves a complete revision and approves only the current version', async () => {
    const api = createDemoReviewApi();
    const decisions = [
      'statement-root-cause',
      'statement-access',
      'statement-deployment',
      'statement-recovery',
    ].map((statementId) => ({ statementId, decision: 'KEEP' as const }));

    const createBody = JSON.stringify(revisionRequest(decisions));
    const created = await api(
      demoConfiguration,
      token,
      `/review/incidents/${demoIncidentId}/revisions`,
      {
        method: 'POST',
        body: createBody,
      },
    );
    const replayedCreate = await api(
      demoConfiguration,
      token,
      `/review/incidents/${demoIncidentId}/revisions`,
      { method: 'POST', body: createBody },
    );
    expect(replayedCreate).toEqual(created);
    const saved = bundleSchema.parse(
      await api(
        demoConfiguration,
        token,
        `/review/incidents/${demoIncidentId}`,
      ),
    );
    expect(saved.latestRevision).toMatchObject({ status: 'DRAFT' });
    expect(saved.incident.version).toBe(8);

    const approveBody = JSON.stringify({
      incidentId: demoIncidentId,
      revisionId: '10420000-0000-4000-8000-000000000003',
      expectedIncidentVersion: 8,
      clientRequestId: '10420000-0000-4000-8000-000000000099',
    });
    const approval = await api(
      demoConfiguration,
      token,
      `/review/incidents/${demoIncidentId}/revisions/10420000-0000-4000-8000-000000000003/approve`,
      {
        method: 'POST',
        body: approveBody,
      },
    );
    const replayedApproval = await api(
      demoConfiguration,
      token,
      `/review/incidents/${demoIncidentId}/revisions/10420000-0000-4000-8000-000000000003/approve`,
      { method: 'POST', body: approveBody },
    );
    expect(replayedApproval).toEqual(approval);
    const approved = bundleSchema.parse(
      await api(
        demoConfiguration,
        token,
        `/review/incidents/${demoIncidentId}`,
      ),
    );
    expect(approved.incident.status).toBe('APPROVED');
    expect(approved.latestRevision?.status).toBe('APPROVED');

    await expect(
      api(
        demoConfiguration,
        token,
        `/review/incidents/${demoIncidentId}/revisions/10420000-0000-4000-8000-000000000003/approve`,
        {
          method: 'POST',
          body: JSON.stringify({
            incidentId: demoIncidentId,
            revisionId: '10420000-0000-4000-8000-000000000003',
            expectedIncidentVersion: 8,
            clientRequestId: '10420000-0000-4000-8000-000000000098',
          }),
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

function revisionRequest(
  decisions: readonly {
    readonly statementId: string;
    readonly decision: 'KEEP';
  }[],
): RevisionRequest {
  return {
    incidentId: demoIncidentId,
    reportDraftId: '10420000-0000-4000-8000-000000000002',
    expectedIncidentVersion: 7,
    clientRequestId: '10420000-0000-4000-8000-000000000090',
    acknowledgedContradictions: true,
    acknowledgedOpenQuestions: true,
    questionAnswers: [
      {
        questionId: 'question-session',
        answer:
          'The acquisition path remains unknown and requires investigation.',
      },
    ],
    additionalStatements: [],
    decisions,
  };
}
