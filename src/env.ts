import { z } from 'zod'

const envSchema = z.object({
  // Mattermost
  MATTERMOST_URL: z.string().url(),
  MATTERMOST_TOKEN: z.string().min(1),

  // Model — format: providerID/modelID, e.g. anthropic/claude-sonnet-4-6
  MODEL: z.string().default('anthropic/claude-sonnet-4-6'),

  // Internal
  OPENVIKING_URL: z.string().url().default('http://openviking:1933'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment configuration:')
    console.error(result.error.flatten().fieldErrors)
    process.exit(1)
  }
  return result.data
}
