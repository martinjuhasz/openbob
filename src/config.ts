// Static runtime configuration (not from env — env is in env.ts)

import path from 'path';

export const DATA_DIR = process.env['DATA_DIR'] ?? '/data';
export const GROUPS_DIR = process.env['GROUPS_DIR'] ?? '/workspace/groups';
export const SKILLS_DIR = process.env['SKILLS_DIR'] ?? '/skills';
export const POLL_INTERVAL = 2000; // ms
export const ASSISTANT_NAME = process.env['ASSISTANT_NAME'] ?? 'yetaclaw';

export const DB_PATH = path.join(DATA_DIR, 'yetaclaw.db');

/** Derive full channel name from a JID prefix (e.g. `tg:123` → `'telegram'`). */
export function channelFromJid(jid: string): string {
  const colonIndex = jid.indexOf(':');
  if (colonIndex === -1) return 'unknown';
  const prefix = jid.slice(0, colonIndex);
  const prefixToChannel: Record<string, string> = {
    tg: 'telegram',
    mm: 'mattermost',
  };
  return prefixToChannel[prefix] ?? 'unknown';
}
