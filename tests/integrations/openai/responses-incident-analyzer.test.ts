import { describe, expect, it, vi } from 'vitest';
import { IncidentAnalyzerError } from '../../../src/application/ports/incident-analyzer.js';
import { ResponsesIncidentAnalyzer } from '../../../src/integrations/openai/responses-incident-analyzer.js';

const manifest = {
  incidentTitle: 'Checkout outage',
  evidence: [
    {
      id: 'artifact-1',
      sourceType: 'SLACK_MESSAGE',
      occurredAt: '2026-07-18T01:00:00.000Z',
      authorReference: 'participant_1',
      content: 'Rollback started and errors declined.',
    },
  ],
};

const analysis = {
  timeline: [
    {
      key: 'rollback_started',
      occurredAt: '2026-07-18T01:00:00.000Z',
      summary: 'The rollback started.',
      classification: 'participant_assertion',
      evidenceIds: ['artifact-1'],
    },
  ],
  claims: [
    {
      key: 'errors_declined',
      statement: 'Errors declined after rollback started.',
      classification: 'correlated_inference',
      supportingEvidenceIds: ['artifact-1'],
      contradictingEvidenceIds: [],
    },
  ],
  openQuestions: [],
};

function successfulResponse(output = analysis): Response {
  return new Response(
    JSON.stringify({
      id: 'resp-1',
      model: 'approved-model-2026-07-01',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(output) }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function adapter(request: typeof fetch): ResponsesIncidentAnalyzer {
  return new ResponsesIncidentAnalyzer({
    apiKey: 'test-api-key',
    model: 'approved-model-snapshot',
    timeoutMilliseconds: 30_000,
    maxOutputTokens: 4_000,
    fetch: request,
  });
}

describe('ResponsesIncidentAnalyzer', () => {
  it('requests non-stored strict output and validates evidence citations', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(successfulResponse());

    await expect(
      adapter(request).analyze({
        manifest,
        availableEvidenceIds: new Set(['artifact-1']),
        clientRequestId: 'client-request-1',
      }),
    ).resolves.toEqual({
      analysis,
      providerResponseId: 'resp-1',
      model: 'approved-model-2026-07-01',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    const call = request.mock.calls[0];
    expect(call?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(call?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer test-api-key',
      'X-Client-Request-Id': 'client-request-1',
    });
    const requestBody = call?.[1]?.body;
    expect(typeof requestBody).toBe('string');
    if (typeof requestBody !== 'string') {
      throw new Error('Expected a JSON string request body');
    }
    const body = JSON.parse(requestBody) as unknown;
    expect(body).toMatchObject({
      model: 'approved-model-snapshot',
      store: false,
      tools: [],
      text: {
        format: {
          type: 'json_schema',
          name: 'incident_analysis',
          strict: true,
        },
      },
    });
    expect(body).toMatchObject({
      text: {
        format: {
          schema: {
            $defs: {
              evidenceId: {
                type: 'string',
                enum: ['artifact-1'],
              },
            },
          },
        },
      },
    });
  });

  it('rejects model output containing a fabricated evidence ID', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      successfulResponse({
        ...analysis,
        timeline: [
          { ...analysis.timeline[0]!, evidenceIds: ['fabricated-id'] },
        ],
      }),
    );

    await expect(
      adapter(request).analyze({
        manifest,
        availableEvidenceIds: new Set(['artifact-1']),
        clientRequestId: 'client-request-1',
      }),
    ).rejects.toMatchObject({
      code: 'OPENAI_UNKNOWN_EVIDENCE_REFERENCE',
      retryable: true,
    });
  });

  it('reports application schema failures without logging model content', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      successfulResponse({
        ...analysis,
        claims: [
          {
            ...analysis.claims[0]!,
            supportingEvidenceIds: ['artifact-1', 'artifact-1'],
          },
        ],
      }),
    );

    await expect(
      adapter(request).analyze({
        manifest,
        availableEvidenceIds: new Set(['artifact-1']),
        clientRequestId: 'client-request-1',
      }),
    ).rejects.toMatchObject({
      code: 'OPENAI_INVALID_ANALYSIS_SCHEMA',
      retryable: true,
    });
  });

  it('rejects an invalid internal evidence schema before calling OpenAI', async () => {
    const request = vi.fn<typeof fetch>();

    await expect(
      adapter(request).analyze({
        manifest,
        availableEvidenceIds: new Set(),
        clientRequestId: 'client-request-1',
      }),
    ).rejects.toMatchObject({
      code: 'OPENAI_INVALID_EVIDENCE_SCHEMA',
      retryable: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('honours bounded rate-limit retry hints', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"error":{"message":"sensitive provider detail"}}', {
        status: 429,
        headers: { 'retry-after': '12' },
      }),
    );

    await expect(
      adapter(request).analyze({
        manifest,
        availableEvidenceIds: new Set(['artifact-1']),
        clientRequestId: 'client-request-1',
      }),
    ).rejects.toMatchObject({
      code: 'OPENAI_RATE_LIMITED',
      retryable: true,
      retryAfterSeconds: 12,
    });
  });

  it('treats a safety refusal as terminal instead of repeatedly billing it', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp-refusal',
          model: 'approved-model-2026-07-01',
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'refusal', refusal: 'cannot comply' }],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
        }),
        { status: 200 },
      ),
    );

    await expect(
      adapter(request).analyze({
        manifest,
        availableEvidenceIds: new Set(['artifact-1']),
        clientRequestId: 'client-request-1',
      }),
    ).rejects.toMatchObject({ code: 'OPENAI_REFUSAL', retryable: false });
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not automatically retry an ambiguous network failure', async () => {
    const sensitiveDetail = 'socket failed after sending test-api-key';
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(sensitiveDetail));
    let caught: unknown;

    try {
      await adapter(request).analyze({
        manifest,
        availableEvidenceIds: new Set(['artifact-1']),
        clientRequestId: 'client-request-1',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IncidentAnalyzerError);
    expect(caught).toMatchObject({
      code: 'OPENAI_OUTCOME_UNKNOWN',
      retryable: false,
    });
    expect(String(caught)).not.toContain(sensitiveDetail);
    expect(request).toHaveBeenCalledOnce();
  });
});
