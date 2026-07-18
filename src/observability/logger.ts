import pino, { type Logger, type LoggerOptions } from 'pino';

const options: LoggerOptions = {
  base: null,
  messageKey: 'message',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body',
      'request.body',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.signingSecret',
      '*.databaseUrl',
      '*.apiKey',
      '*.openAiApiKey',
      '*.modelResponse',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    // Dependency and schema errors can echo source text in their messages or
    // stacks. Normal logs retain only bounded diagnostic identifiers; detailed
    // source-aware diagnostics belong in an explicitly access-controlled sink.
    err: serializeError,
    req: (request: { id?: string; method?: string; url?: string }) => ({
      id: request.id,
      method: request.method,
      url: request.url,
    }),
  },
};

export function createLogger(level: string): Logger {
  return pino({ ...options, level });
}

export function serializeError(error: unknown): {
  readonly type: string;
  readonly code?: string;
} {
  if (!(error instanceof Error)) {
    return { type: 'UnknownError' };
  }

  const candidateCode = (error as Error & { code?: unknown }).code;
  const code =
    typeof candidateCode === 'string' &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(candidateCode)
      ? candidateCode
      : undefined;
  return {
    type: error.name,
    ...(code === undefined ? {} : { code }),
  };
}
