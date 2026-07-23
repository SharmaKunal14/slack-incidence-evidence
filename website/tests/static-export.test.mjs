import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const output = new URL('../out/', import.meta.url);

test('exports the landing page as static HTML', async () => {
  const html = await readFile(new URL('index.html', output), 'utf8');

  assert.match(html, /OnRecord — Put every incident on the record/);
  assert.match(html, /The incident is over/);
  assert.match(html, /href="\/review-demo\/demo\.html"/);
  assert.doesNotMatch(html, /signin-with-chatgpt/);
});

test('exports a static demo redirect and all public demo assets', async () => {
  const redirectPage = await readFile(
    new URL('demo/index.html', output),
    'utf8',
  );
  const film = await stat(new URL('video/onrecord-workflow-120s.mp4', output));

  assert.match(
    redirectPage,
    /http-equiv="refresh" content="0;url=\/review-demo\/demo\.html"/i,
  );
  assert.ok(film.size > 5_000_000);
  await Promise.all([
    access(new URL('review-demo/demo.html', output)),
    access(new URL('review-demo/app.js', output)),
    access(new URL('review-demo/styles.css', output)),
    access(new URL('video/onrecord-workflow-120s.vtt', output)),
    access(new URL('og.png', output)),
  ]);
});

test('uses the configured public URL for absolute social metadata', async () => {
  const html = await readFile(new URL('index.html', output), 'utf8');
  const expectedUrl =
    process.env.NEXT_PUBLIC_SITE_URL ??
    'https://onrecord-evidence.kvsharma-ks-14.chatgpt.site';

  assert.match(html, new RegExp(`${escapeRegExp(expectedUrl)}/og\\.png`));
});

test('rewrites clean CloudFront routes without touching static assets', async () => {
  const functionSource = await readFile(
    new URL('../infrastructure/cloudfront-url-rewrite.js', import.meta.url),
    'utf8',
  );
  const rewrite = (uri) =>
    vm.runInNewContext(
      `${functionSource}; handler({ request: { uri: ${JSON.stringify(uri)} } }).uri`,
    );

  assert.equal(rewrite('/'), '/index.html');
  assert.equal(rewrite('/demo'), '/demo/index.html');
  assert.equal(rewrite('/demo/'), '/demo/index.html');
  assert.equal(rewrite('/review-demo/app.js'), '/review-demo/app.js');
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
