import { cp, mkdir, rm } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = fileURLToPath(
  new URL('../artifacts/review-web/', import.meta.url),
);

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  absWorkingDir: projectRoot,
  bundle: true,
  entryPoints: ['web/src/app.ts'],
  entryNames: 'app',
  format: 'iife',
  legalComments: 'none',
  minify: true,
  outdir: outputDirectory,
  platform: 'browser',
  sourcemap: false,
  target: ['es2022'],
});

await Promise.all([
  cp(
    fileURLToPath(new URL('../web/index.html', import.meta.url)),
    `${outputDirectory}/index.html`,
  ),
  cp(
    fileURLToPath(new URL('../web/styles.css', import.meta.url)),
    `${outputDirectory}/styles.css`,
  ),
]);

process.stdout.write(`Created ${outputDirectory}\n`);
