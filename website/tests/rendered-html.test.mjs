import assert from 'node:assert/strict';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import test from 'node:test';

async function render(pathname = '/') {
  const workerUrl = new URL('../dist/server/index.js', import.meta.url);
  workerUrl.searchParams.set('test', `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(pathname, 'http://localhost/'), {
      headers: { accept: 'text/html' },
    }),
    {
      ASSETS: {
        fetch: async () => new Response('Not found', { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test('server-renders the OnRecord landing page', async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>OnRecord — Put every incident on the record<\/title>/i,
  );
  assert.match(html, /The incident is over/);
  assert.match(html, /The truth isn’t ready/);
  assert.match(html, /Fluent is not the same as true/);
  assert.match(html, /One incident/);
  assert.match(html, /Three acts/);
  assert.match(html, /Start with the evidence/);
  assert.match(html, /Separate fact from assumption/);
  assert.match(html, /Let a human make the record/);
  assert.match(html, /Every sentence has somewhere to point/);
  assert.match(html, /The model drafts/);
  assert.match(html, /Your team decides/);
  assert.match(html, /Put the incident on the record/);
  assert.match(html, /The implementation stack/);
  assert.match(html, /OpenAI Responses API/);
  assert.match(html, /incident.review.requested/);
  assert.match(html, /Publisher Lambda/);
  assert.match(html, /EventBridge/);
  const orderedSections = [
    'Fluent is not the same as true',
    'One incident',
    'Every sentence has somewhere to point',
    'The model drafts',
    'Production review components',
    'Put the incident on the record',
    'Want to see how it is built',
    'The implementation stack',
  ];
  for (let index = 1; index < orderedSections.length; index += 1) {
    assert.ok(
      html.indexOf(orderedSections[index - 1]) <
        html.indexOf(orderedSections[index]),
      `${orderedSections[index - 1]} should appear before ${orderedSections[index]}`,
    );
  }
  assert.match(html, /href="\/review-demo\/demo\.html"/);
  assert.match(
    html,
    /href="https:\/\/dk95lfvlz4v6e\.cloudfront\.net\/#\/settings\/integrations"/,
  );
  assert.match(html, /Connect your Slack/);
  assert.match(html, /Watch the 2-minute story/);
  assert.match(html, /id="method"/);
  assert.match(html, /id="technical"/);
  assert.match(html, /id="architecture"/);
  assert.doesNotMatch(html, /Capability ledger/);
  assert.doesNotMatch(
    html,
    /codex-preview|Your site is taking shape|react-loading-skeleton/i,
  );
});

test('routes the demo directly to the production review interface', async () => {
  const response = await render('/demo');
  assert.equal(response.status, 200);
  assert.match(
    await response.text(),
    /http-equiv="refresh" content="0;url=\/review-demo\/demo\.html"/i,
  );
});

test('keeps the wide architecture board centered during its reveal transition', async () => {
  const styles = await readFile(
    new URL('../app/globals.css', import.meta.url),
    'utf8',
  );
  assert.match(
    styles,
    /\.motion-ready \.architecture-section \.architecture-map\[data-reveal\]\.is-visible\s*\{\s*transform: translateX\(-50%\) translateY\(0\)/,
  );
});

test('renders Lambda journey nodes without decorative OpenAI icon overlays', async () => {
  const source = await readFile(
    new URL('../app/site-experience.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /title: "Analysis Lambda"[^\n]+icons: \[awsIcon\([^\]]+\)\]/,
  );
  assert.match(
    source,
    /title: "Report Lambda"[^\n]+icons: \[awsIcon\([^\]]+\)\]/,
  );
  assert.doesNotMatch(
    source,
    /title: "(?:Analysis|Report) Lambda"[^\n]+openAiIcon/,
  );
});

test('ships finished metadata, product proof imagery, local technology artwork, and no starter preview', async () => {
  const [
    layout,
    packageJson,
    previewFiles,
    socialImage,
    demoApp,
    reviewOverview,
    evidenceReview,
    awsLambda,
    openAiMark,
    slackMark,
  ] = await Promise.all([
    readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readdir(new URL('../app/_sites-preview/', import.meta.url)),
    stat(new URL('../public/og.png', import.meta.url)),
    stat(new URL('../public/review-demo/app.js', import.meta.url)),
    stat(new URL('../public/proof/review-overview.jpg', import.meta.url)),
    stat(new URL('../public/proof/evidence-review.jpg', import.meta.url)),
    stat(new URL('../public/tech/aws/Arch_AWS-Lambda_64.png', import.meta.url)),
    stat(new URL('../public/tech/openai-blossom.svg', import.meta.url)),
    stat(new URL('../public/tech/slack-official.png', import.meta.url)),
  ]);

  assert.deepEqual(previewFiles, []);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(layout, /export const metadata/);
  assert.match(layout, /\/og\.png/);
  assert.ok(socialImage.size > 100_000);
  assert.ok(demoApp.size > 100_000);
  assert.ok(reviewOverview.size > 50_000);
  assert.ok(evidenceReview.size > 50_000);
  assert.ok(awsLambda.size > 1_000);
  assert.ok(openAiMark.size > 1_000);
  assert.ok(slackMark.size > 1_000);
  await access(new URL('../public/favicon.svg', import.meta.url));
});

test('renders the OpenAI mark as a cropped, high-contrast icon', async () => {
  const [mark, styles] = await Promise.all([
    readFile(
      new URL('../public/tech/openai-blossom.svg', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
  ]);
  assert.match(mark, /viewBox="126 207 308 305"/);
  assert.doesNotMatch(mark, /width="1183" height="719"/);
  assert.match(
    styles,
    /\.technology-icon\[data-dark="true"\] img\s*\{\s*filter: invert\(1\)/,
  );
});

test('ships the web-optimized workflow film and its accessible supporting assets', async () => {
  const [film, poster, captions] = await Promise.all([
    stat(new URL('../public/video/onrecord-workflow-120s.mp4', import.meta.url)),
    stat(
      new URL('../public/video/onrecord-workflow-poster.jpg', import.meta.url),
    ),
    readFile(
      new URL('../public/video/onrecord-workflow-120s.vtt', import.meta.url),
      'utf8',
    ),
  ]);
  assert.ok(film.size > 5_000_000);
  assert.ok(film.size < 25_000_000);
  assert.ok(poster.size > 100_000);
  assert.match(captions, /^WEBVTT/);
  assert.match(captions, /Follow the Confluence link/);
});
