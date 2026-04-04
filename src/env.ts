import { z } from 'zod';

/** Treat empty / whitespace-only strings as undefined so optional fields stay optional. */
const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const envSchema = z.object({
  // Mattermost (optional — only needed if Mattermost channel is used)
  MATTERMOST_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  MATTERMOST_TOKEN: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),

  // Telegram (optional — only needed if Telegram channel is used)
  TELEGRAM_BOT_TOKEN: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),

  // Model — format: providerID/modelID, e.g. anthropic/claude-sonnet-4-6
  // Required — the model name is provider-specific, no sensible default exists.
  MODEL: z.string().min(1),

  // Comma-separated list of env var names to forward to agent containers.
  // Example: ANTHROPIC_API_KEY,OPENROUTER_API_KEY,AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY
  AGENT_FORWARD_ENV: z.preprocess(emptyToUndefined, z.string().optional()),

  // Agent response timeout in ms. How long to wait for an agent to finish processing a prompt.
  // Default: 480000 (8 minutes)
  AGENT_TIMEOUT: z.coerce.number().positive().optional(),

  // Agent container startup timeout in ms. How long to wait for the OpenCode server health check.
  // Default: 30000 (30 seconds)
  AGENT_STARTUP_TIMEOUT: z.coerce.number().positive().optional(),

  // Idle timeout in ms. Containers are stopped after this duration without activity.
  // Default: undefined (containers run forever)
  IDLE_TIMEOUT: z.coerce.number().positive().optional(),

  // Internal
  OPENVIKING_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error'])
    .default('info'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function loadEnv(): Env {
  if (_env) return _env;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:');
    console.error(result.error.flatten().fieldErrors);
    process.exit(1);
  }
  _env = result.data;
  return _env;
}

export function getEnv(): Env {
  if (!_env) throw new Error('loadEnv() must be called before getEnv()');
  return _env;
}
