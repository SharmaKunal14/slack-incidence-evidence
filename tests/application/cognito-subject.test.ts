import { describe, expect, it } from 'vitest';
import { cognitoSubjectSchema } from '../../src/application/identity/cognito-subject.js';

describe('Cognito subject validation', () => {
  it('treats the signed subject as an opaque identifier instead of an RFC UUID', () => {
    const nonRfcUuidSubject = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    expect(cognitoSubjectSchema.parse(nonRfcUuidSubject)).toBe(
      nonRfcUuidSubject,
    );
  });

  it('rejects empty, control-character, and oversized subjects', () => {
    expect(cognitoSubjectSchema.safeParse('').success).toBe(false);
    expect(cognitoSubjectSchema.safeParse('subject\nvalue').success).toBe(
      false,
    );
    expect(cognitoSubjectSchema.safeParse('s'.repeat(129)).success).toBe(false);
  });
});
