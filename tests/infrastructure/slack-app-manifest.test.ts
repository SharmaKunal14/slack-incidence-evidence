import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SLACK_REQUIRED_BOT_SCOPES } from '../../src/application/onboarding/slack-installation.js';

describe('Slack app manifest', () => {
  it('matches the application-owned required bot scopes', async () => {
    const manifest = await readFile(
      resolve('config/slack-app-manifest.yaml'),
      'utf8',
    );
    const botScopeBlock =
      /^oauth_config:\n {2}scopes:\n {4}bot:\n(?<scopes>(?: {6}- [a-z:_]+\n)+)/mu.exec(
        manifest,
      )?.groups?.scopes;
    expect(botScopeBlock).toBeDefined();

    const manifestScopes = (botScopeBlock ?? '')
      .split('\n')
      .map((line) => line.replace(/^\s*-\s*/u, '').trim())
      .filter((scope) => scope.length > 0);

    expect(manifestScopes).toEqual([...SLACK_REQUIRED_BOT_SCOPES]);
  });
});
