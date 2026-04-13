// Static runtime configuration (not from env — env is in env.ts)

import path from 'path';

export const DATA_DIR = process.env['DATA_DIR'] ?? '/data';
/** Per-group runtime directories live under DATA_DIR/groups/<folder>/ */
export const GROUPS_DIR = path.join(DATA_DIR, 'groups');
export const SKILLS_DIR = process.env['SKILLS_DIR'] ?? '/skills';
export const POLL_INTERVAL = 2000; // ms
export const ASSISTANT_NAME = process.env['ASSISTANT_NAME'] ?? 'openbob';

export const DB_PATH = path.join(DATA_DIR, 'openbob.db');

/** Derive full channel name from a JID prefix (e.g. `tg:123` → `'telegram'`). */
export function channelFromJid(jid: string): string {
  const colonIndex = jid.indexOf(':');
  if (colonIndex === -1) return 'unknown';
  const prefix = jid.slice(0, colonIndex);
  const prefixToChannel: Record<string, string> = {
    tg: 'telegram',
    mx: 'matrix',
  };
  return prefixToChannel[prefix] ?? 'unknown';
}

/**
 * Allowed pattern for group folder names.
 * Must be a valid slug: lowercase alphanumeric, dots, hyphens, underscores.
 * Must start with a letter or digit. Max 64 characters.
 */
const GROUP_FOLDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Validate a group folder name.
 * Returns true if the name is a safe slug for use in filesystem paths and Docker names.
 */
export function isValidGroupFolder(folder: string): boolean {
  return GROUP_FOLDER_PATTERN.test(folder);
}
