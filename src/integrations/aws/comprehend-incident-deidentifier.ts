import { DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import {
  IncidentDeidentificationError,
  type DeidentifyIncidentTextInput,
  type IncidentDeidentifier,
  type InspectIncidentTextInput,
  type KnownIncidentPerson,
} from '../../application/ports/incident-deidentifier.js';

const MAX_COMPREHEND_TEXT_BYTES = 90_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_REDACTION_PASSES = 3;
// Incident timestamps are required evidence and are already supplied to the
// model as structured occurredAt fields. Free-form input dates are still
// redacted; only generated output may retain DATE_TIME findings.
const ALLOWED_OUTPUT_ENTITY_TYPES = new Set(['DATE_TIME']);

interface ComprehendClientLike {
  send(
    command: DetectPiiEntitiesCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<{
    readonly Entities?: readonly {
      readonly Type?: string;
      readonly Score?: number;
      readonly BeginOffset?: number;
      readonly EndOffset?: number;
    }[];
  }>;
}

interface Finding {
  readonly type: string;
  readonly begin: number;
  readonly end: number;
  readonly value: string;
}

export interface ComprehendIncidentDeidentifierConfiguration {
  readonly languageCode: 'en' | 'es';
  readonly minimumConfidence: number;
  readonly timeoutMilliseconds: number;
  readonly concurrency?: number;
  readonly onScan?: (event: IncidentPrivacyScanEvent) => void;
}

export interface IncidentPrivacyScanEvent {
  readonly operation: 'DEIDENTIFICATION' | 'SAFETY_CHECK';
  readonly pass: number;
  readonly findingCount: number;
  readonly findingTypes: readonly string[];
  readonly status: 'REDACTED' | 'SAFE' | 'BLOCKED';
}

/** Layered deterministic replacement plus managed NER detection. */
export class ComprehendIncidentDeidentifier implements IncidentDeidentifier {
  private readonly concurrency: number;

  public constructor(
    private readonly client: ComprehendClientLike,
    private readonly configuration: ComprehendIncidentDeidentifierConfiguration,
  ) {
    if (
      !Number.isFinite(configuration.minimumConfidence) ||
      configuration.minimumConfidence < 0.5 ||
      configuration.minimumConfidence > 1
    ) {
      throw new Error('PII confidence threshold must be between 0.5 and 1');
    }
    if (
      !Number.isSafeInteger(configuration.timeoutMilliseconds) ||
      configuration.timeoutMilliseconds < 1_000 ||
      configuration.timeoutMilliseconds > 30_000
    ) {
      throw new Error(
        'PII detection timeout must be between 1000 and 30000 ms',
      );
    }
    this.concurrency = configuration.concurrency ?? DEFAULT_CONCURRENCY;
    if (
      !Number.isSafeInteger(this.concurrency) ||
      this.concurrency < 1 ||
      this.concurrency > 10
    ) {
      throw new Error('PII detection concurrency must be between 1 and 10');
    }
  }

  public async deidentify(
    input: DeidentifyIncidentTextInput,
  ): Promise<readonly string[]> {
    validateKnownPeople(input.knownPeople ?? []);
    const replacementState = new ReplacementState();
    let redacted = input.texts.map((text) =>
      redactDeterministic(
        replaceKnownPeople(text, input.knownPeople ?? []),
        replacementState,
      ),
    );

    for (let pass = 1; pass <= MAX_REDACTION_PASSES; pass += 1) {
      const localTypes = localFindingTypes(redacted, input.knownPeople ?? []);
      if (localTypes.length > 0) {
        this.reportScan({
          operation: 'DEIDENTIFICATION',
          pass,
          findingCount: localTypes.length,
          findingTypes: uniqueSorted(localTypes),
          status: 'BLOCKED',
        });
        throw new IncidentDeidentificationError('PII_REMAINS', false);
      }

      const findings = await mapWithConcurrency(
        redacted,
        this.concurrency,
        (text) => this.detect(text),
      );
      const flattened = findings.flat();
      if (flattened.length === 0) {
        this.reportScan({
          operation: 'DEIDENTIFICATION',
          pass,
          findingCount: 0,
          findingTypes: [],
          status: 'SAFE',
        });
        return redacted;
      }
      this.reportScan({
        operation: 'DEIDENTIFICATION',
        pass,
        findingCount: flattened.length,
        findingTypes: uniqueSorted(flattened.map((finding) => finding.type)),
        status: 'REDACTED',
      });
      redacted = redacted.map((text, index) =>
        replaceFindings(text, findings[index] ?? [], replacementState),
      );
    }

    const residualFindings = await mapWithConcurrency(
      redacted,
      this.concurrency,
      (text) => this.detect(text),
    );
    const flattenedResidualFindings = residualFindings.flat();
    if (flattenedResidualFindings.length > 0) {
      this.reportScan({
        operation: 'DEIDENTIFICATION',
        pass: MAX_REDACTION_PASSES + 1,
        findingCount: flattenedResidualFindings.length,
        findingTypes: uniqueSorted(
          flattenedResidualFindings.map((finding) => finding.type),
        ),
        status: 'BLOCKED',
      });
      throw new IncidentDeidentificationError('PII_REMAINS', false);
    }
    this.reportScan({
      operation: 'DEIDENTIFICATION',
      pass: MAX_REDACTION_PASSES + 1,
      findingCount: 0,
      findingTypes: [],
      status: 'SAFE',
    });
    return redacted;
  }

  public async assertSafe(input: InspectIncidentTextInput): Promise<void> {
    validateKnownPeople(input.knownPeople ?? []);
    const localTypes = localFindingTypes(input.texts, input.knownPeople ?? []);
    if (localTypes.length > 0) {
      this.reportScan({
        operation: 'SAFETY_CHECK',
        pass: 1,
        findingCount: localTypes.length,
        findingTypes: uniqueSorted(localTypes),
        status: 'BLOCKED',
      });
      throw new IncidentDeidentificationError('PII_REMAINS', false);
    }
    const findings = await mapWithConcurrency(
      input.texts,
      this.concurrency,
      (text) => this.detect(text),
    );
    const blockingFindings = findings
      .flat()
      .filter((finding) => !ALLOWED_OUTPUT_ENTITY_TYPES.has(finding.type));
    if (blockingFindings.length > 0) {
      this.reportScan({
        operation: 'SAFETY_CHECK',
        pass: 1,
        findingCount: blockingFindings.length,
        findingTypes: uniqueSorted(
          blockingFindings.map((finding) => finding.type),
        ),
        status: 'BLOCKED',
      });
      throw new IncidentDeidentificationError('PII_REMAINS', false);
    }
    this.reportScan({
      operation: 'SAFETY_CHECK',
      pass: 1,
      findingCount: 0,
      findingTypes: [],
      status: 'SAFE',
    });
  }

  private reportScan(event: IncidentPrivacyScanEvent): void {
    this.configuration.onScan?.(event);
  }

  private async detect(text: string): Promise<readonly Finding[]> {
    validateText(text);
    if (text.trim().length === 0) {
      return [];
    }
    let output: Awaited<ReturnType<ComprehendClientLike['send']>>;
    try {
      output = await this.client.send(
        new DetectPiiEntitiesCommand({
          LanguageCode: this.configuration.languageCode,
          Text: text,
        }),
        {
          abortSignal: AbortSignal.timeout(
            this.configuration.timeoutMilliseconds,
          ),
        },
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new IncidentDeidentificationError(
        'PII_DETECTOR_UNAVAILABLE',
        [
          'InternalServerException',
          'ServiceUnavailableException',
          'ThrottlingException',
          'TimeoutError',
          'AbortError',
        ].includes(name),
        { cause: error },
      );
    }
    const codePoints = Array.from(text);
    const controlledRanges = controlledPlaceholderRanges(text);
    const findings: Finding[] = [];
    for (const entity of output.Entities ?? []) {
      if (
        entity.Score === undefined ||
        entity.Score < this.configuration.minimumConfidence ||
        entity.Type === undefined ||
        entity.BeginOffset === undefined ||
        entity.EndOffset === undefined ||
        !Number.isSafeInteger(entity.BeginOffset) ||
        !Number.isSafeInteger(entity.EndOffset) ||
        entity.BeginOffset < 0 ||
        entity.EndOffset <= entity.BeginOffset ||
        entity.EndOffset > codePoints.length ||
        controlledRanges.some(
          (range) =>
            entity.BeginOffset! < range.end && entity.EndOffset! > range.begin,
        )
      ) {
        continue;
      }
      const value = codePoints
        .slice(entity.BeginOffset, entity.EndOffset)
        .join('');
      if (isControlledPlaceholder(value)) {
        continue;
      }
      findings.push({
        type: normalizeEntityType(entity.Type),
        begin: codePointOffsetToStringOffset(codePoints, entity.BeginOffset),
        end: codePointOffsetToStringOffset(codePoints, entity.EndOffset),
        value,
      });
    }
    return removeOverlappingFindings(findings);
  }
}

function localFindingTypes(
  texts: readonly string[],
  knownPeople: readonly KnownIncidentPerson[],
): string[] {
  const types: string[] = [];
  for (const text of texts) {
    validateText(text);
    if (containsKnownPerson(text, knownPeople)) {
      types.push('KNOWN_PERSON');
    }
    types.push(...findDeterministicPii(text).map((finding) => finding.type));
  }
  return types;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

class ReplacementState {
  private readonly references = new Map<string, string>();
  private readonly counts = new Map<string, number>();

  public replacement(type: string, value: string): string {
    const normalizedType = normalizeEntityType(type);
    const key = `${normalizedType}:${value.normalize('NFKC').toLocaleLowerCase()}`;
    const existing = this.references.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const count = (this.counts.get(normalizedType) ?? 0) + 1;
    this.counts.set(normalizedType, count);
    const replacement = `[${normalizedType}_${count}]`;
    this.references.set(key, replacement);
    return replacement;
  }
}

function replaceKnownPeople(
  text: string,
  people: readonly KnownIncidentPerson[],
): string {
  const aliases = people
    .flatMap((person) =>
      [person.externalId, ...person.aliases].map((alias) => ({
        alias,
        replacement: person.replacement,
      })),
    )
    .sort((left, right) => right.alias.length - left.alias.length);
  let output = text;
  for (const { alias, replacement } of aliases) {
    const escaped = escapeRegExp(alias);
    output = output.replace(new RegExp(`<@${escaped}>`, 'gu'), replacement);
    output = output.replace(
      new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu'),
      replacement,
    );
  }
  return output;
}

function containsKnownPerson(
  text: string,
  people: readonly KnownIncidentPerson[],
): boolean {
  if (replaceKnownPeople(text, people) !== text) {
    return true;
  }
  const canonicalText = ` ${canonicalWords(text)} `;
  return people.some((person) =>
    [person.externalId, ...person.aliases].some((alias) => {
      const canonicalAlias = canonicalWords(alias);
      return (
        canonicalAlias.length >= 4 &&
        canonicalText.includes(` ${canonicalAlias} `)
      );
    }),
  );
}

function redactDeterministic(
  text: string,
  replacements: ReplacementState,
): string {
  let output = text;
  for (const pattern of deterministicPatterns()) {
    output = output.replace(pattern.expression, (value: string) =>
      pattern.validate(value)
        ? replacements.replacement(pattern.type, value)
        : value,
    );
  }
  return output;
}

function findDeterministicPii(text: string): readonly Finding[] {
  const findings: Finding[] = [];
  for (const pattern of deterministicPatterns()) {
    for (const match of text.matchAll(pattern.expression)) {
      const value = match[0];
      if (match.index !== undefined && pattern.validate(value)) {
        findings.push({
          type: pattern.type,
          begin: match.index,
          end: match.index + value.length,
          value,
        });
      }
    }
  }
  return findings;
}

function deterministicPatterns(): readonly {
  readonly type: string;
  readonly expression: RegExp;
  readonly validate: (value: string) => boolean;
}[] {
  return [
    {
      type: 'EMAIL',
      expression:
        /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/giu,
      validate: () => true,
    },
    {
      type: 'SLACK_USER',
      expression: /<@[A-Z][A-Z0-9]{1,63}>|\bU[A-Z0-9]{8,63}\b/gu,
      validate: () => true,
    },
    {
      type: 'SECRET',
      expression:
        /\bAKIA[A-Z0-9]{16}\b|\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/giu,
      validate: () => true,
    },
    {
      type: 'IP_ADDRESS',
      expression: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
      validate: (value) =>
        value
          .split('.')
          .every((part) => Number(part) >= 0 && Number(part) <= 255),
    },
    {
      type: 'PHONE',
      expression: /(?<![\w.])\+?\d(?:[ ()-]*\d){7,14}(?![\w.])/gu,
      validate: (value) => {
        const digits = value.replace(/\D/gu, '');
        return (
          digits.length >= 8 &&
          digits.length <= 15 &&
          (value.startsWith('+') ||
            /[ ()-]/u.test(value) ||
            digits.length >= 10)
        );
      },
    },
  ];
}

function replaceFindings(
  text: string,
  findings: readonly Finding[],
  replacements: ReplacementState,
): string {
  let output = text;
  for (const finding of [...findings].sort((a, b) => b.begin - a.begin)) {
    output = `${output.slice(0, finding.begin)}${replacements.replacement(
      finding.type,
      finding.value,
    )}${output.slice(finding.end)}`;
  }
  return output;
}

function removeOverlappingFindings(findings: readonly Finding[]): Finding[] {
  const sorted = [...findings].sort(
    (left, right) => left.begin - right.begin || right.end - left.end,
  );
  const output: Finding[] = [];
  for (const finding of sorted) {
    const previous = output.at(-1);
    if (previous !== undefined && finding.begin < previous.end) {
      continue;
    }
    output.push(finding);
  }
  return output;
}

function validateKnownPeople(people: readonly KnownIncidentPerson[]): void {
  const replacements = new Set<string>();
  for (const person of people) {
    if (
      !/^[A-Z][A-Z0-9]{1,63}$/u.test(person.externalId) ||
      !/^participant_[1-9]\d{0,3}$/u.test(person.replacement) ||
      replacements.has(person.replacement) ||
      person.aliases.some((alias) => alias.length < 2 || alias.length > 255)
    ) {
      throw new IncidentDeidentificationError(
        'PII_IDENTITY_MAP_INVALID',
        false,
      );
    }
    replacements.add(person.replacement);
  }
}

function validateText(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_COMPREHEND_TEXT_BYTES) {
    throw new IncidentDeidentificationError('PII_TEXT_TOO_LARGE', false);
  }
}

function codePointOffsetToStringOffset(
  codePoints: readonly string[],
  offset: number,
): number {
  return codePoints.slice(0, offset).join('').length;
}

function normalizeEntityType(type: string): string {
  const normalized = type.toUpperCase().replace(/[^A-Z0-9_]/gu, '_');
  return normalized.length === 0 ? 'PII' : normalized.slice(0, 40);
}

function isControlledPlaceholder(value: string): boolean {
  return (
    /^\[[A-Z][A-Z0-9_]{0,39}_[1-9]\d{0,5}\]$/u.test(value.trim()) ||
    /^participant_[1-9]\d{0,3}$/u.test(value.trim())
  );
}

function controlledPlaceholderRanges(
  text: string,
): readonly { readonly begin: number; readonly end: number }[] {
  const expression =
    /\[[A-Z][A-Z0-9_]{0,39}_[1-9]\d{0,5}\]|participant_[1-9]\d{0,3}/gu;
  return [...text.matchAll(expression)].flatMap((match) => {
    if (match.index === undefined) {
      return [];
    }
    const begin = Array.from(text.slice(0, match.index)).length;
    return [{ begin, end: begin + Array.from(match[0]).length }];
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function canonicalWords(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        output[index] = await mapper(values[index] as T);
      }
    }),
  );
  return output;
}
