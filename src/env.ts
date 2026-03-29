import { z } from 'zod';

const envSchema = z.object({
  // Mattermost
  MATTERMOST_URL: z.string().url(),
  MATTERMOST_TOKEN: z.string().min(1),

  // Model — format: providerID/modelID, e.g. anthropic/claude-sonnet-4-6
  // Required — the model name is provider-specific, no sensible default exists.
  MODEL: z.string().min(1),

  // Comma-separated list of env var names to forward to agent containers.
  // Example: ANTHROPIC_API_KEY,OPENROUTER_API_KEY,AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY
  AGENT_FORWARD_ENV: z.string().optional(),

  // Internal
  OPENVIKING_URL: z.string().url().optional(),
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
