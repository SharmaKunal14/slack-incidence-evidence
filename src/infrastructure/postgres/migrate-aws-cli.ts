import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { loadDatabaseMigrationEnvironment } from '../../config/environment.js';
import { parseDatabaseConnectionSecret } from '../../config/runtime-secrets.js';
import { createLogger } from '../../observability/logger.js';
import { SecretsManagerSecretReader } from '../secrets/secrets-manager-secret-reader.js';
import { runMigrations } from './migration-runner.js';
import {
  assertDatabaseSchemaCompatible,
  DatabaseSchemaCompatibilityError,
} from './schema-compatibility.js';

const environment = loadDatabaseMigrationEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
const secrets = new SecretsManagerClient({
  region: environment.AWS_REGION,
  ...(environment.AWS_ENDPOINT_URL === undefined
    ? {}
    : { endpoint: environment.AWS_ENDPOINT_URL }),
});
let database: Pool | undefined;

try {
  const secretReader = new SecretsManagerSecretReader(secrets);
  const secretValue = await secretReader.readString(
    environment.DATABASE_SECRET_ARN,
  );
  const connectionSecret = parseDatabaseConnectionSecret(secretValue);
  database = new Pool({
    host: environment.DATABASE_HOST,
    port: environment.DATABASE_PORT,
    database: environment.DATABASE_NAME,
    user: connectionSecret.username,
    password: connectionSecret.password,
    ssl: environment.DATABASE_SSL
      ? {
          ca: connectionSecret.caCertificate,
          rejectUnauthorized: true,
        }
      : false,
    application_name: 'incident-evidence-copilot-release-migrations',
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    max: 1,
  });
  database.on('error', (error) => {
    logger.error({ err: error }, 'idle PostgreSQL migration client failed');
  });

  const result = await runMigrations(database, {
    appliedBy: `github-actions:${process.env['GITHUB_RUN_ID'] ?? 'manual'}`,
    logger,
  });
  await assertDatabaseSchemaCompatible(database);
  logger.info(
    {
      appliedMigrationCount: result.applied.length,
      alreadyAppliedMigrationCount: result.alreadyApplied,
    },
    'PostgreSQL release migrations and schema verification complete',
  );
} catch (error) {
  logger.fatal(
    {
      err: error,
      ...(error instanceof DatabaseSchemaCompatibilityError &&
      error.diagnostic !== undefined
        ? { migrationLedgerDiagnostic: error.diagnostic }
        : {}),
    },
    'PostgreSQL release migration failed',
  );
  process.exitCode = 1;
} finally {
  secrets.destroy();
  if (database !== undefined) {
    await database.end();
  }
}
