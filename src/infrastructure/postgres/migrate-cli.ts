import { Pool } from 'pg';
import { createLogger } from '../../observability/logger.js';
import { runMigrations } from './migration-runner.js';

const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new Error('DATABASE_URL is required to run PostgreSQL migrations');
  }

  // Migrations intentionally use one connection. The advisory lock belongs to
  // that session and must remain held for the entire migration sequence.
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    application_name: 'incident-evidence-copilot-migrations',
  });

  try {
    const result = await runMigrations(pool, { logger });
    logger.info(
      {
        applied: result.applied,
        alreadyApplied: result.alreadyApplied,
      },
      'PostgreSQL migrations complete',
    );
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  logger.fatal({ err: error }, 'PostgreSQL migration failed');
  process.exitCode = 1;
}
