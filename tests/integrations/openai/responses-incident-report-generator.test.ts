import { describe, expect, it, vi } from 'vitest';
import {
  INCIDENT_REPORT_SECTION_TYPES,
  type IncidentReportManifest,
} from '../../../src/application/report/incident-report.js';
import { ResponsesIncidentReportGenerator } from '../../../src/integrations/openai/responses-incident-report-generator.js';

const manifest: IncidentReportManifest = {
  incidentTitle: 'Checkout outage',
  analysisRunId: 'analysis-1',
  claims: [
    {
      id: 'claim-1',
      statement: 'Recovery followed rollback.',
      classification: 'correlated_inference',
      supportingEvidenceCount: 1,
      contradictingEvidenceCount: 0,
    },
  ],
  timeline: [],
  openQuestions: [],
};

function output(claimId = 'claim-1'): unknown {
  return {
    sections: INCIDENT_REPORT_SECTION_TYPES.map((sectionType) => ({
      sectionType,
      statements:
        sectionType === 'executive_summary'
          ? [
              {
                key: 'recovery_summary',
                statementType: 'claim',
                text: 'Recovery followed rollback.',
                classification: 'correlated_inference',
                claimIds: [claimId],
                timelineEventIds: [],
              },
            ]
          : [],
    })),
  };
}

function response(report = output()): Response {
  return new Response(
    JSON.stringify({
      id: 'resp-report-1',
      model: 'approved-model-2026-07-01',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(report) }],
        },
      ],
      usage: { input_tokens: 80, output_tokens: 40, total_tokens: 120 },
    }),
    { status: 200 },
  );
}

function generator(request: typeof fetch): ResponsesIncidentReportGenerator {
  return new ResponsesIncidentReportGenerator({
    apiKey: 'test-api-key',
    model: 'approved-model-snapshot',
    timeoutMilliseconds: 30_000,
    maxOutputTokens: 8_000,
    fetch: request,
  });
}

describe('ResponsesIncidentReportGenerator', () => {
  it('requests a non-stored strict report and validates source references', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());

    await expect(
      generator(request).generate({
        manifest,
        clientRequestId: 'request-1',
      }),
    ).resolves.toMatchObject({
      providerResponseId: 'resp-report-1',
      model: 'approved-model-2026-07-01',
      usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
    });

    const body = request.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') {
      throw new Error('Expected a JSON request body');
    }
    expect(JSON.parse(body)).toMatchObject({
      model: 'approved-model-snapshot',
      store: false,
      tools: [],
      text: {
        format: {
          type: 'json_schema',
          name: 'incident_report',
          strict: true,
        },
      },
    });
  });

  it('rejects a fabricated claim reference', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(output('fabricated-claim')));

    await expect(
      generator(request).generate({ manifest, clientRequestId: 'request-1' }),
    ).rejects.toMatchObject({
      code: 'OPENAI_REPORT_INVALID_DRAFT',
      retryable: true,
    });
  });

  it('does not automatically retry an ambiguous network outcome', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('socket closed after request'));

    await expect(
      generator(request).generate({ manifest, clientRequestId: 'request-1' }),
    ).rejects.toMatchObject({
      code: 'OPENAI_REPORT_OUTCOME_UNKNOWN',
      retryable: false,
    });
    expect(request).toHaveBeenCalledOnce();
  });
});
