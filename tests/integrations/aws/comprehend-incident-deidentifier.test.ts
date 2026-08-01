import type { DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import { describe, expect, it, vi } from 'vitest';
import type { IncidentDeidentificationError } from '../../../src/application/ports/incident-deidentifier.js';
import { ComprehendIncidentDeidentifier } from '../../../src/integrations/aws/comprehend-incident-deidentifier.js';

function offsets(text: string, value: string): { begin: number; end: number } {
  const prefix = Array.from(text.slice(0, text.indexOf(value))).length;
  return { begin: prefix, end: prefix + Array.from(value).length };
}

function deidentifier(
  send: (command: DetectPiiEntitiesCommand) => Promise<{
    Entities?: readonly {
      Type?: string;
      Score?: number;
      BeginOffset?: number;
      EndOffset?: number;
    }[];
  }>,
): ComprehendIncidentDeidentifier {
  return new ComprehendIncidentDeidentifier(
    { send },
    {
      languageCode: 'en',
      minimumConfidence: 0.9,
      timeoutMilliseconds: 5_000,
      concurrency: 2,
    },
  );
}

describe('ComprehendIncidentDeidentifier', () => {
  it('removes known identities and structured PII before managed detection', async () => {
    const seen: string[] = [];
    const send = vi.fn((command: DetectPiiEntitiesCommand) => {
      const text = command.input.Text ?? '';
      seen.push(text);
      const value = 'Paulo Santos';
      if (!text.includes(value)) {
        return Promise.resolve({ Entities: [] });
      }
      const entityOffsets = offsets(text, value);
      return Promise.resolve({
        Entities: [
          {
            Type: 'NAME',
            Score: 0.999,
            BeginOffset: entityOffsets.begin,
            EndOffset: entityOffsets.end,
          },
        ],
      });
    });

    await expect(
      deidentifier(send).deidentify({
        texts: [
          'Sarah Patel emailed jane@example.com from 10.0.0.1. Paulo Santos approved.',
        ],
        knownPeople: [
          {
            externalId: 'U12345678',
            replacement: 'participant_1',
            aliases: ['Sarah Patel'],
          },
        ],
      }),
    ).resolves.toEqual([
      'participant_1 emailed [EMAIL_1] from [IP_ADDRESS_1]. [NAME_1] approved.',
    ]);

    expect(seen[0]).not.toContain('Sarah Patel');
    expect(seen[0]).not.toContain('jane@example.com');
    expect(seen[0]).not.toContain('10.0.0.1');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('blocks output when a high-confidence PII entity remains', async () => {
    const send = vi.fn((command: DetectPiiEntitiesCommand) => {
      const text = command.input.Text ?? '';
      const value = 'Jane Citizen';
      const entityOffsets = offsets(text, value);
      return Promise.resolve({
        Entities: [
          {
            Type: 'NAME',
            Score: 0.99,
            BeginOffset: entityOffsets.begin,
            EndOffset: entityOffsets.end,
          },
        ],
      });
    });

    await expect(
      deidentifier(send).assertSafe({ texts: ['Jane Citizen approved it.'] }),
    ).rejects.toMatchObject({ code: 'PII_REMAINS', retryable: false });
  });

  it('fails closed when Comprehend is unavailable', async () => {
    const send = vi.fn(() => {
      const error = new Error('service unavailable');
      error.name = 'ServiceUnavailableException';
      return Promise.reject(error);
    });

    await expect(
      deidentifier(send).deidentify({ texts: ['No obvious identifier'] }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<IncidentDeidentificationError>>({
        code: 'PII_DETECTOR_UNAVAILABLE',
        retryable: true,
      }),
    );
  });
});
