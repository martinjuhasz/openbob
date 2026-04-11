// SQLite database — messages, groups, sessions, tasks

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DB_PATH } from './config.js';
import { logger } from './logger.js';
import { GroupConfig, NewMessage, ScheduledTask } from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid                TEXT PRIMARY KEY,
      name               TEXT,
      channel            TEXT,
      is_group           INTEGER DEFAULT 0,
      last_message_time  TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id             TEXT,
      chat_jid       TEXT,
      sender         TEXT NOT NULL,
      sender_name    TEXT NOT NULL,
      content        TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      is_from_me     INTEGER DEFAULT 0,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS registered_groups (
      jid            TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      folder         TEXT NOT NULL UNIQUE,
      trigger        TEXT NOT NULL,
      channel        TEXT NOT NULL,
      is_main        INTEGER DEFAULT 0,
      always_respond INTEGER DEFAULT 0,
      model          TEXT,
      created_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS router_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id             TEXT PRIMARY KEY,
      jid            TEXT NOT NULL,
      group_folder   TEXT NOT NULL,
      prompt         TEXT NOT NULL,
      schedule_type  TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode   TEXT NOT NULL DEFAULT 'isolated',
      status         TEXT NOT NULL DEFAULT 'active',
      next_run       INTEGER,
      created_at     INTEGER NOT NULL,
      created_by     TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run, status);
  `);
}

export function initDatabase(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  createSchema(db);
  // Migration: add always_respond column if missing (existing DBs)
  const cols = (
    db.prepare(`PRAGMA table_info(registered_groups)`).all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
  if (!cols.includes('always_respond')) {
    db.prepare(
      `ALTER TABLE registered_groups ADD COLUMN always_respond INTEGER DEFAULT 0`,
    ).run();
    // Backfill: groups that were main should always respond
    db.prepare(
      `UPDATE registered_groups SET always_respond = is_main WHERE always_respond = 0`,
    ).run();
  }
  // Migration: add model column if missing (existing DBs)
  if (!cols.includes('model')) {
    db.prepare(`ALTER TABLE registered_groups ADD COLUMN model TEXT`).run();
  }
  // Migration: add ov_user_key column if missing (per-group OpenViking user keys)
  if (!cols.includes('ov_user_key')) {
    db.prepare(
      `ALTER TABLE registered_groups ADD COLUMN ov_user_key TEXT`,
    ).run();
  }
  logger.info({ dbPath: DB_PATH }, 'Database initialised');
}

// --- Messages ---

export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getRecentMessages(chatJid: string, limit = 20): NewMessage[] {
  return (
    db
      .prepare(
        `SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(chatJid, limit) as NewMessage[]
  ).reverse();
}

export function getMessagesSince(
  chatJid: string,
  since: string,
  limit = 50,
): NewMessage[] {
  return db
    .prepare(
      `SELECT * FROM messages WHERE chat_jid = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?`,
    )
    .all(chatJid, since, limit) as NewMessage[];
}

export function getNewMessages(since: string): NewMessage[] {
  return db
    .prepare(
      `SELECT * FROM messages WHERE timestamp > ? ORDER BY timestamp ASC`,
    )
    .all(since) as NewMessage[];
}

// --- Chat metadata ---

export function storeChatMetadata(
  jid: string,
  lastMessageTime: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, channel, is_group, last_message_time)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      last_message_time = excluded.last_message_time,
      name    = COALESCE(excluded.name, chats.name),
      channel = COALESCE(excluded.channel, chats.channel),
      is_group = COALESCE(excluded.is_group, chats.is_group)
  `,
  ).run(jid, name ?? null, channel ?? null, isGroup ? 1 : 0, lastMessageTime);
}

// --- Registered groups ---

export function getAllRegisteredGroups(): Record<string, GroupConfig> {
  const rows = db.prepare(`SELECT * FROM registered_groups`).all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger: string;
    channel: string;
    is_main: number;
    always_respond: number;
    model: string | null;
    created_at: number;
  }>;
  const result: Record<string, GroupConfig> = {};
  for (const row of rows) {
    result[row.jid] = {
      jid: row.jid,
      name: row.name,
      folder: row.folder,
      trigger: row.trigger,
      channel: row.channel,
      isMain: row.is_main === 1,
      alwaysRespond: row.always_respond === 1,
      model: row.model ?? undefined,
      createdAt: row.created_at,
    };
  }
  return result;
}

export function setRegisteredGroup(config: GroupConfig): void {
  db.prepare(
    `
    INSERT INTO registered_groups (jid, name, folder, trigger, channel, is_main, always_respond, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      name           = excluded.name,
      folder         = excluded.folder,
      trigger        = excluded.trigger,
      channel        = excluded.channel,
      is_main        = excluded.is_main,
      always_respond = excluded.always_respond,
      model          = excluded.model
  `,
  ).run(
    config.jid,
    config.name,
    config.folder,
    config.trigger,
    config.channel,
    config.isMain ? 1 : 0,
    config.alwaysRespond ? 1 : 0,
    config.model ?? null,
    config.createdAt,
  );
}

export function deleteRegisteredGroup(jid: string): void {
  db.prepare(`DELETE FROM registered_groups WHERE jid = ?`).run(jid);
}

// --- OpenViking per-group user keys ---

export function getOvUserKey(groupFolder: string): string | null {
  const row = db
    .prepare(`SELECT ov_user_key FROM registered_groups WHERE folder = ?`)
    .get(groupFolder) as { ov_user_key: string | null } | undefined;
  return row?.ov_user_key ?? null;
}

export function setOvUserKey(groupFolder: string, key: string): void {
  db.prepare(
    `UPDATE registered_groups SET ov_user_key = ? WHERE folder = ?`,
  ).run(key, groupFolder);
}

export function migrateGroupJid(oldJid: string, newJid: string): boolean {
  const txn = db.transaction(() => {
    // Defer FK checks so we can update parent+child rows in any order
    db.pragma('defer_foreign_keys = ON');

    const groupResult = db
      .prepare(`UPDATE registered_groups SET jid = ? WHERE jid = ?`)
      .run(newJid, oldJid);
    if (groupResult.changes === 0) return false;

    // Update chats table
    db.prepare(`UPDATE chats SET jid = ? WHERE jid = ?`).run(newJid, oldJid);

    // Update messages referencing the old JID
    db.prepare(`UPDATE messages SET chat_jid = ? WHERE chat_jid = ?`).run(
      newJid,
      oldJid,
    );

    // Update scheduled tasks referencing the old JID
    db.prepare(`UPDATE scheduled_tasks SET jid = ? WHERE jid = ?`).run(
      newJid,
      oldJid,
    );

    return true;
  });
  return txn();
}

// --- Sessions ---

export function getSession(groupFolder: string): string | null {
  const row = db
    .prepare(`SELECT session_id FROM sessions WHERE group_folder = ?`)
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    `
    INSERT INTO sessions (group_folder, session_id) VALUES (?, ?)
    ON CONFLICT(group_folder) DO UPDATE SET session_id = excluded.session_id
  `,
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare(`DELETE FROM sessions WHERE group_folder = ?`).run(groupFolder);
}

// --- Router state ---

export function getRouterState(key: string): string | null {
  const row = db
    .prepare(`SELECT value FROM router_state WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    `
    INSERT INTO router_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `,
  ).run(key, value);
}

// --- Scheduled tasks ---

export function getActiveTasks(): ScheduledTask[] {
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks WHERE status = 'active' ORDER BY next_run ASC`,
    )
    .all() as ScheduledTask[];
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC`,
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`)
    .all() as ScheduledTask[];
}

export function upsertTask(task: ScheduledTask): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, jid, group_folder, prompt, schedule_type, schedule_value, context_mode, status, next_run, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status   = excluded.status,
      next_run = excluded.next_run
  `,
  ).run(
    task.id,
    task.jid,
    task.group_folder,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode,
    task.status,
    task.next_run,
    task.created_at,
    task.created_by,
  );
}

export function deleteTask(id: string): void {
  db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
}

export function updateTask(
  id: string,
  fields: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'context_mode'
      | 'status'
      | 'next_run'
    >
  >,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.prompt !== undefined) {
    sets.push('prompt = ?');
    values.push(fields.prompt);
  }
  if (fields.schedule_type !== undefined) {
    sets.push('schedule_type = ?');
    values.push(fields.schedule_type);
  }
  if (fields.schedule_value !== undefined) {
    sets.push('schedule_value = ?');
    values.push(fields.schedule_value);
  }
  if (fields.context_mode !== undefined) {
    sets.push('context_mode = ?');
    values.push(fields.context_mode);
  }
  if (fields.status !== undefined) {
    sets.push('status = ?');
    values.push(fields.status);
  }
  if (fields.next_run !== undefined) {
    sets.push('next_run = ?');
    values.push(fields.next_run);
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}
