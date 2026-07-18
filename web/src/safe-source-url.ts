const EXACT_ALLOWED_HOSTS = new Set(['github.com']);

export function safeSourceUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    const url = new URL(value);
    const allowedHost =
      EXACT_ALLOWED_HOSTS.has(url.hostname) ||
      (url.hostname !== 'slack.com' && url.hostname.endsWith('.slack.com'));
    return url.protocol === 'https:' &&
      allowedHost &&
      url.username === '' &&
      url.password === '' &&
      url.port === ''
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
