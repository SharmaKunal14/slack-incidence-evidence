import { describe, expect, it } from 'vitest';
import { safeSourceUrl } from '../../web/src/safe-source-url.js';

describe('review source URL allowlist', () => {
  it('allows only plain HTTPS Slack workspace and GitHub origins', () => {
    expect(
      safeSourceUrl('https://workspace.slack.com/archives/C001/p1234567890'),
    ).toBe('https://workspace.slack.com/archives/C001/p1234567890');
    expect(safeSourceUrl('https://github.com/example/repository/pull/42')).toBe(
      'https://github.com/example/repository/pull/42',
    );

    expect(
      safeSourceUrl('http://workspace.slack.com/archives/C001'),
    ).toBeNull();
    expect(safeSourceUrl('https://slack.com.evil.example/incident')).toBeNull();
    expect(
      safeSourceUrl('https://user:password@github.com/example'),
    ).toBeNull();
    expect(safeSourceUrl('https://github.com:444/example')).toBeNull();
    expect(safeSourceUrl('https://127.0.0.1/latest/meta-data')).toBeNull();
    expect(safeSourceUrl('not a URL')).toBeNull();
  });
});
