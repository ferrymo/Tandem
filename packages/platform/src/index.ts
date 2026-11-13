import { z } from 'zod';
import pino from 'pino';
export { createSessionCodec } from './session-crypto';
export { LoginLimiter } from './login-limiter';
const pgUrl = z
  .string()
  .url()
  .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'));
const base = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error', 'silent'])
    .default('info'),
});
export function readWebEnv(env: NodeJS.ProcessEnv = process.env) {
  return base.extend({ DATABASE_URL: pgUrl }).parse(env);
}
export function readCollaborationEnv(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      TANDEM_PUBLIC_URL: z
        .string()
        .url()
        .default('http://127.0.0.1:3000')
        .refine((value) => {
          const url = new URL(value);
          return (
            ['http:', 'https:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === '/'
          );
        }),
      SESSION_ENCRYPTION_KEY: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z
          .string()
          .regex(/^[a-f0-9]{64}$/i)
          .optional(),
      ),
      TANDEM_IDENTITY_URL: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.string().url().optional(),
      ),
      TANDEM_IDENTITY_ID: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,80}$/)
        .default('primary'),
      TANDEM_IDENTITY_LABEL: z.string().min(1).max(120).default('协作系统'),
      TANDEM_COMMANDER_ACCOUNTS: z
        .string()
        .default('')
        .transform((value) =>
          value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
        ),
      TANDEM_IDENTITY_ALLOW_HTTP: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    })
    .parse(env);
}
export function readWorkerEnv(env: NodeJS.ProcessEnv = process.env) {
  return base
    .extend({
      WORKER_DATABASE_URL: pgUrl,
      WORKER_POLL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
      WORKER_LEASE_MS: z.coerce
        .number()
        .int()
        .min(3000)
        .max(300000)
        .default(30000),
      WORKER_SHUTDOWN_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(60000)
        .default(10000),
    })
    .parse(env);
}
export function createLogger(service: string, level = 'info') {
  return pino(
    {
      name: service,
      level,
      redact: {
        paths: [
          'password',
          'token',
          'authorization',
          'credential',
          'databaseUrl',
          '*.password',
          '*.token',
          '*.authorization',
          'req.headers.authorization',
          'req.headers.cookie',
        ],
        censor: '[REDACTED]',
      },
    },
    pino.destination(2),
  );
}
export function safeErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{2,40}$/.test(error.code)
  )
    return error.code;
  return 'INTERNAL_ERROR';
}
