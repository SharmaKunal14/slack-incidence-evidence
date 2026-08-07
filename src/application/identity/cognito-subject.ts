import { z } from 'zod';

/**
 * Cognito `sub` is an issuer-scoped opaque identifier. Preserve it exactly;
 * UUID version/variant validation is incorrect and normalization can change
 * the identity used for tenant authorization.
 */
export const cognitoSubjectSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);
