// Static runtime configuration (not from env — env is in env.ts)

import path from 'path'

export const DATA_DIR = process.env['DATA_DIR'] ?? '/data'
export const GROUPS_DIR = process.env['GROUPS_DIR'] ?? '/workspace/groups'
export const POLL_INTERVAL = 2000 // ms
export const IDLE_TIMEOUT = 10 * 60 * 1000 // 10 minutes
export const ASSISTANT_NAME = process.env['ASSISTANT_NAME'] ?? 'yetaclaw'

export const DB_PATH = path.join(DATA_DIR, 'yetaclaw.db')
