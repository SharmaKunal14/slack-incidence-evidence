import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

async function createFakeCommand(
  directory: string,
  name: string,
  contents: string,
): Promise<void> {
  const path = resolve(directory, name);
  await writeFile(path, contents, 'utf8');
  await chmod(path, 0o700);
}

async function runBootstrap(
  subjectPrefix: string,
): Promise<SpawnSyncReturns<string>> {
  const commandDirectory = await mkdtemp(
    resolve(tmpdir(), 'incident-bootstrap-test-'),
  );
  temporaryDirectories.push(commandDirectory);

  await createFakeCommand(
    commandDirectory,
    'aws',
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "sts get-caller-identity" ]]; then
  printf '393209814365\n'
fi
`,
  );
  await createFakeCommand(
    commandDirectory,
    'gh',
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${FAKE_GITHUB_SUBJECT_PREFIX:?}"
`,
  );

  return spawnSync(
    resolve('infrastructure/bootstrap/deploy.sh'),
    [
      '--environment',
      'development',
      '--github-repository',
      'SharmaKunal14/slack-incidence-evidence',
      '--state-bucket',
      'incident-copilot-tfstate-393209814365-ap-southeast-2',
      '--state-key',
      'incident-copilot/development/terraform.tfstate',
      '--state-kms-key-arn',
      'arn:aws:kms:ap-southeast-2:393209814365:key/c98cc529-04fa-4622-9e15-5c1935072888',
      '--migration-secret-arn',
      'arn:aws:secretsmanager:ap-southeast-2:393209814365:secret:incident-copilot/development/database-example',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        AWS_REGION: 'ap-southeast-2',
        FAKE_GITHUB_SUBJECT_PREFIX: subjectPrefix,
        PATH: `${commandDirectory}:${process.env['PATH'] ?? ''}`,
      },
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe('deployment bootstrap script', () => {
  it('uses GitHub immutable owner and repository IDs in the environment subject', async () => {
    const result = await runBootstrap(
      'repo:SharmaKunal14@104818699/slack-incidence-evidence@1303701406',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Using GitHub OIDC subject repo:SharmaKunal14@104818699/slack-incidence-evidence@1303701406:environment:development',
    );
  });

  it('rejects a subject prefix for a different repository', async () => {
    const result = await runBootstrap(
      'repo:SharmaKunal14@104818699/different-repository@1303701406',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'GitHub OIDC subject repository does not match the requested repository',
    );
  });
});
