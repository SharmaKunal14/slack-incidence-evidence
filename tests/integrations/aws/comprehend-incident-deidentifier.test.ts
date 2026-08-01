import type { DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import { describe, expect, it, vi } from 'vitest';
import type { IncidentDeidentificationError } from '../../../src/application/ports/incident-deidentifier.js';
import { ComprehendIncidentDeidentifier } from '../../../src/integrations/aws/comprehend-incident-deidentifier.js';
import type { IncidentPrivacyScanEvent } from '../../../src/integrations/aws/comprehend-incident-deidentifier.js';

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
  onScan?: (event: IncidentPrivacyScanEvent) => void,
): ComprehendIncidentDeidentifier {
  return new ComprehendIncidentDeidentifier(
    { send },
    {
      languageCode: 'en',
      minimumConfidence: 0.9,
      timeoutMilliseconds: 5_000,
      concurrency: 2,
      ...(onScan === undefined ? {} : { onScan }),
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

  it('redacts entities discovered after an earlier replacement', async () => {
    const scans: IncidentPrivacyScanEvent[] = [];
    const send = vi.fn((command: DetectPiiEntitiesCommand) => {
      const text = command.input.Text ?? '';
      const value = text.includes('Paulo Santos')
        ? 'Paulo Santos'
        : text.includes('[NAME_1]') && text.includes('123 Main Street')
          ? '123 Main Street'
          : null;
      if (value === null) {
        return Promise.resolve({ Entities: [] });
      }
      const entityOffsets = offsets(text, value);
      return Promise.resolve({
        Entities: [
          {
            Type: value === 'Paulo Santos' ? 'NAME' : 'ADDRESS',
            Score: 0.99,
            BeginOffset: entityOffsets.begin,
            EndOffset: entityOffsets.end,
          },
        ],
      });
    });

    await expect(
      deidentifier(send, (event) => scans.push(event)).deidentify({
        texts: ['Paulo Santos approved work at 123 Main Street.'],
      }),
    ).resolves.toEqual(['[NAME_1] approved work at [ADDRESS_1].']);

    expect(send).toHaveBeenCalledTimes(3);
    expect(scans).toEqual([
      {
        operation: 'DEIDENTIFICATION',
        pass: 1,
        findingCount: 1,
        findingTypes: ['NAME'],
        status: 'REDACTED',
      },
      {
        operation: 'DEIDENTIFICATION',
        pass: 2,
        findingCount: 1,
        findingTypes: ['ADDRESS'],
        status: 'REDACTED',
      },
      {
        operation: 'DEIDENTIFICATION',
        pass: 3,
        findingCount: 0,
        findingTypes: [],
        status: 'SAFE',
      },
    ]);
    expect(JSON.stringify(scans)).not.toContain('Paulo Santos');
    expect(JSON.stringify(scans)).not.toContain('123 Main Street');
  });

  it('fails closed when findings remain after the bounded passes', async () => {
    const sequence = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
    const send = vi.fn((command: DetectPiiEntitiesCommand) => {
      const text = command.input.Text ?? '';
      const value = sequence.find((candidate) => text.includes(candidate));
      if (value === undefined) {
        return Promise.resolve({ Entities: [] });
      }
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
      deidentifier(send).deidentify({
        texts: ['Alpha Bravo Charlie Delta'],
      }),
    ).rejects.toMatchObject({ code: 'PII_REMAINS', retryable: false });
    expect(send).toHaveBeenCalledTimes(4);
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
