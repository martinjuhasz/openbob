// Static runtime configuration (not from env — env is in env.ts)

import path from 'path'

export const DATA_DIR = process.env['DATA_DIR'] ?? '/data'
export const GROUPS_DIR = process.env['GROUPS_DIR'] ?? '/workspace/groups'
export const SKILLS_DIR = process.env['SKILLS_DIR'] ?? '/skills'
export const POLL_INTERVAL = 2000 // ms
export const IDLE_TIMEOUT = 60 * 60 * 1000 // 1 hour
export const ASSISTANT_NAME = process.env['ASSISTANT_NAME'] ?? 'yetaclaw'

export const DB_PATH = path.join(DATA_DIR, 'yetaclaw.db')
