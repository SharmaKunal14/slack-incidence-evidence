import { z } from 'zod';

const providerToken = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[\x21-\x7e]+$/u);

const successSchema = z
  .object({
    ok: z.literal(true),
    access_token: providerToken,
    token_type: z.literal('bot'),
    scope: z.string().trim().min(1).max(4_096),
    bot_user_id: z.string().regex(/^[UW][A-Z0-9]{1,63}$/u),
    app_id: z.string().regex(/^A[A-Z0-9]{1,63}$/u),
    team: z
      .object({
        id: z.string().regex(/^T[A-Z0-9]{1,63}$/u),
        name: z.string().trim().min(1).max(200),
      })
      .passthrough(),
    enterprise: z
      .object({
        id: z.string().regex(/^E[A-Z0-9]{1,63}$/u),
        name: z.string().trim().min(1).max(200),
      })
      .passthrough()
      .nullable()
      .optional(),
    authed_user: z
      .object({
        id: z.string().regex(/^[UW][A-Z0-9]{1,63}$/u),
      })
      .passthrough(),
    refresh_token: providerToken.optional(),
    expires_in: z.number().int().positive().max(604_800).optional(),
    is_enterprise_install: z.boolean().optional(),
  })
  .passthrough()
  .superRefine((response, context) => {
    if (
      (response.refresh_token === undefined) !==
      (response.expires_in === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['refresh_token'],
        message: 'Slack rotation fields must be present together',
      });
    }
  });

const failureSchema = z
  .object({
    ok: z.literal(false),
    error: z.string().trim().min(1).max(128),
  })
  .passthrough();

export const slackOAuthV2AccessResponseSchema = z.union([
  successSchema,
  failureSchema,
]);

export type SlackOAuthV2AccessResponse = z.infer<
  typeof slackOAuthV2AccessResponseSchema
>;

export function parseSlackOAuthV2AccessResponse(
  value: unknown,
): SlackOAuthV2AccessResponse {
  return slackOAuthV2AccessResponseSchema.parse(value);
}
