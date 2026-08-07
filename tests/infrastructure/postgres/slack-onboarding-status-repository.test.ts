import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  PostgresSlackOnboardingStatusRepository,
  SlackOnboardingStatusConfigurationError,
} from '../../../src/infrastructure/postgres/slack-onboarding-status-repository.js';

function result<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return { command: 'SELECT', fields: [], oid: 0, rowCount: rows.length, rows };
}

const baseRow = {
  tenant_id: 'T001',
  display_name: 'Acme Engineering',
  tenant_status: 'ACTIVE',
  role: 'ADMIN',
  membership_status: 'ACTIVE',
  team_id: 'T001',
  installation_status: 'ACTIVE',
  installed_at: new Date('2026-08-05T01:00:00.000Z'),
  connection_updated_at: new Date('2026-08-05T01:05:00.000Z'),
  credential_expires_at: null,
} as const;

describe('PostgresSlackOnboardingStatusRepository', () => {
  it('returns safe connected metadata for an active administrator', async () => {
    const query = vi.fn().mockResolvedValue(result([baseRow]));
    const repository = new PostgresSlackOnboardingStatusRepository({ query });

    await expect(
      repository.findByCognitoSubject('9f218e92-36a8-455d-869c-a76e27b399df'),
    ).resolves.toEqual({
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
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE membership.cognito_subject = $1'),
      ['9f218e92-36a8-455d-869c-a76e27b399df', 51],
    );
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).not.toContain('credential_secret_arn');
    expect(sql).not.toContain('installed_by_user_id');
  });

  it('allows a first installation for a subject with no membership', async () => {
    const repository = new PostgresSlackOnboardingStatusRepository({
      query: vi.fn().mockResolvedValue(result([])),
    });

    await expect(
      repository.findByCognitoSubject('9f218e92-36a8-455d-869c-a76e27b399df'),
    ).resolves.toEqual({ canStartInstallation: true, workspaces: [] });
  });

  it('hides revoked memberships and prevents them from starting again', async () => {
    const repository = new PostgresSlackOnboardingStatusRepository({
      query: vi.fn().mockResolvedValue(
        result([
          {
            ...baseRow,
            membership_status: 'REVOKED',
            installation_status: 'REVOKED',
          },
        ]),
      ),
    });

    await expect(
      repository.findByCognitoSubject('9f218e92-36a8-455d-869c-a76e27b399df'),
    ).resolves.toEqual({ canStartInstallation: false, workspaces: [] });
  });

  it('rejects unbounded membership fan-out', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      ...baseRow,
      tenant_id: `T${String(index).padStart(3, '0')}`,
    }));
    const repository = new PostgresSlackOnboardingStatusRepository({
      query: vi.fn().mockResolvedValue(result(rows)),
    });

    await expect(
      repository.findByCognitoSubject('9f218e92-36a8-455d-869c-a76e27b399df'),
    ).rejects.toBeInstanceOf(SlackOnboardingStatusConfigurationError);
  });
});
