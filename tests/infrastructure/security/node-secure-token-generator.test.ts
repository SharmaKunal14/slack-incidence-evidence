import { describe, expect, it } from 'vitest';
import { NodeSecureTokenGenerator } from '../../../src/infrastructure/security/node-secure-token-generator.js';

describe('NodeSecureTokenGenerator', () => {
  it('generates independent 256-bit base64url tokens', () => {
    const generator = new NodeSecureTokenGenerator();
    const first = generator.generate();
    const second = generator.generate();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second).not.toBe(first);
  });
});
