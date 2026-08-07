import type { Pool } from 'pg';

export class PostgresEligibleIncidentReviewerSource {
  public constructor(private readonly pool: Pool) {}

  public async list(
    workspaceId: string,
  ): Promise<readonly { readonly slackUserId: string }[]> {
    const result = await this.pool.query<{ slack_user_id: string }>(
      `
      SELECT slack_user_id
      FROM reviewer_memberships
      WHERE tenant_id = $1 AND status = 'ACTIVE'
        AND role IN ('OWNER', 'ADMIN', 'REVIEWER')
        AND slack_user_id IS NOT NULL
      ORDER BY role, created_at, slack_user_id
      LIMIT 100
    `,
      [workspaceId],
    );
    return result.rows.map((row) => ({ slackUserId: row.slack_user_id }));
  }
}
