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
  assert.match(
    html,
    /href="https:\/\/dk95lfvlz4v6e\.cloudfront\.net\/#\/settings\/integrations"/,
  );
  assert.match(html, /Connect your Slack/);
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

test('pairs each mobile story chapter with its evidence example', async () => {
  const html = await readFile(new URL('index.html', output), 'utf8');
  const chapters = [...html.matchAll(
    /<article class="story-chapter" data-story-step="(\d)">([\s\S]*?)<\/article>/g,
  )];
  const examples = [
    'Approved Slack scope',
    'WAF rule changed at 08:57:42',
    'Human-approved revision',
  ];

  assert.equal(chapters.length, examples.length);
  for (const [index, chapter] of chapters.entries()) {
    assert.equal(Number(chapter[1]), index);
    assert.ok(chapter[2].includes(examples[index]));
    assert.match(chapter[2], /class="story-inline-panel"/);
    assert.doesNotMatch(chapter[2], /aria-hidden="true"/);
  }
});

test('exports an explicitly associated mobile navigation control', async () => {
  const html = await readFile(new URL('index.html', output), 'utf8');
  const toggle = html.match(/<button[^>]*id="navigation-toggle"[^>]*>/)?.[0];

  assert.ok(toggle);
  assert.match(toggle, /aria-controls="primary-navigation"/);
  assert.match(toggle, /aria-expanded="false"/);
  assert.match(toggle, /aria-label="Toggle navigation"/);
  assert.match(html, /<div[^>]*id="primary-navigation"/);
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
