import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_URL: z.string().superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a valid PostgreSQL URL' });
      return;
    }

    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      ctx.addIssue({ code: 'custom', message: 'must use postgres:// or postgresql://' });
    }
    if (!url.hostname) {
      ctx.addIssue({ code: 'custom', message: 'must include a host' });
    }
    if (!url.username) {
      ctx.addIssue({ code: 'custom', message: 'must include a role' });
    }
    if (!url.pathname.slice(1)) {
      ctx.addIssue({ code: 'custom', message: 'must include a database name' });
    }
    if (url.password) {
      ctx.addIssue({ code: 'custom', message: 'must not contain a password; use DB_PASSWORD_FILE' });
    }
    try {
      decodeURIComponent(url.username);
      decodeURIComponent(url.pathname.slice(1));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'role and database name must use valid percent encoding' });
    }
  }),
  DB_PASSWORD_FILE: z.string().min(1).default('/run/secrets/db_password'),
  DB_PASSWORD: z.string().min(1).optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;

export function validate(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}
