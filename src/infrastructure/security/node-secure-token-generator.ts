import { randomBytes } from 'node:crypto';
import type { SecureTokenGenerator } from '../../application/ports/secure-token-generator.js';

const TOKEN_BYTES = 32;

/** Generates 256 bits of URL-safe entropy for OAuth state and browser binding. */
export class NodeSecureTokenGenerator implements SecureTokenGenerator {
  public generate(): string {
    return randomBytes(TOKEN_BYTES).toString('base64url');
  }
}
