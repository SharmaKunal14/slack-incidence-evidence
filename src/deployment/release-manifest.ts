import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { z } from 'zod';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const fileManifestSchema = z.object({
  path: z.string().min(1),
  sha256: sha256Schema,
  sizeBytes: z.number().int().nonnegative(),
});

export const releaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    lambda: fileManifestSchema,
    reviewWeb: z.object({
      directory: z.literal('review-web'),
      sha256: sha256Schema,
      files: z.array(fileManifestSchema).min(1),
    }),
    database: z.object({
      latestMigrationVersion: z.number().int().positive(),
      migrations: z.array(fileManifestSchema).min(1),
    }),
  })
  .strict();

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function describeFile(
  root: string,
  path: string,
): Promise<ReleaseManifest['lambda']> {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new Error(
      `Release input is not a regular file: ${relative(root, path)}`,
    );
  }
  return {
    path: relative(root, path).split('\\').join('/'),
    sha256: await sha256File(path),
    sizeBytes: metadata.size,
  };
}

async function listRegularFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Release directories must not contain symlinks: ${path}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function hashFileManifest(files: readonly ReleaseManifest['lambda'][]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(file.sha256, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(String(file.sizeBytes), 'utf8');
    hash.update('\n', 'utf8');
  }
  return hash.digest('hex');
}

function migrationVersion(path: string): number {
  const filename = path.split('/').at(-1) ?? '';
  const match = /^(?<version>[0-9]+)_[a-z0-9_]+\.sql$/.exec(filename);
  if (match?.groups?.['version'] === undefined) {
    throw new Error(`Invalid release migration filename: ${filename}`);
  }
  const version = Number(match.groups['version']);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error(`Invalid release migration version: ${filename}`);
  }
  return version;
}

export async function createReleaseManifest(
  projectRoot: string,
  commitSha: string,
): Promise<ReleaseManifest> {
  const normalizedCommitSha = commitSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalizedCommitSha)) {
    throw new Error('Release commit SHA must be a full 40-character Git SHA');
  }

  const artifactsDirectory = resolve(projectRoot, 'artifacts');
  const reviewDirectory = resolve(artifactsDirectory, 'review-web');
  const reviewFiles = await Promise.all(
    (await listRegularFiles(reviewDirectory)).map((path) =>
      describeFile(artifactsDirectory, path),
    ),
  );
  const expectedReviewFiles = [
    'review-web/app.js',
    'review-web/index.html',
    'review-web/styles.css',
  ];
  if (
    JSON.stringify(reviewFiles.map(({ path }) => path).sort()) !==
    JSON.stringify(expectedReviewFiles)
  ) {
    throw new Error('Review release contains unexpected or missing files');
  }

  const migrationFiles = await Promise.all(
    (await listRegularFiles(resolve(projectRoot, 'db/migrations'))).map(
      (path) => describeFile(projectRoot, path),
    ),
  );
  const versions = migrationFiles.map(({ path }) => migrationVersion(path));
  for (let index = 0; index < versions.length; index += 1) {
    if (versions[index] !== index + 1) {
      throw new Error(
        'Release migrations must be contiguous and start at version 1',
      );
    }
  }

  return releaseManifestSchema.parse({
    schemaVersion: 1,
    commitSha: normalizedCommitSha,
    lambda: await describeFile(
      artifactsDirectory,
      resolve(artifactsDirectory, 'incident-copilot-lambda.zip'),
    ),
    reviewWeb: {
      directory: 'review-web',
      sha256: hashFileManifest(reviewFiles),
      files: reviewFiles,
    },
    database: {
      latestMigrationVersion: versions.at(-1),
      migrations: migrationFiles,
    },
  });
}

export async function readReleaseManifest(
  manifestPath: string,
): Promise<ReleaseManifest> {
  const contents = await readFile(manifestPath, 'utf8');
  if (contents.length > 1_048_576) {
    throw new Error('Release manifest exceeds the one-megabyte limit');
  }
  try {
    return releaseManifestSchema.parse(JSON.parse(contents) as unknown);
  } catch {
    throw new Error('Release manifest is invalid');
  }
}
