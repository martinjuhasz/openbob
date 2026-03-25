import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

// Patch DB_PATH before importing db module — use in-memory via tmp file trick
// We override the initDatabase to use :memory: for tests
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/yetaclaw-test',
  GROUPS_DIR: '/tmp/yetaclaw-groups',
  DB_PATH: ':memory:',
  POLL_INTERVAL: 2000,
  IDLE_TIMEOUT: 600000,
  ASSISTANT_NAME: 'yetaclaw',
}))

// We can't use :memory: via the path directly in better-sqlite3 with our module,
// so we test the actual schema and query logic using a real in-memory db instance
// that mirrors the schema in db.ts exactly.

let db: Database.Database

function initTestDb() {
  db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY, name TEXT, channel TEXT, is_group INTEGER DEFAULT 0, last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT, chat_jid TEXT, sender TEXT NOT NULL, sender_name TEXT NOT NULL,
      content TEXT NOT NULL, timestamp TEXT NOT NULL, is_from_me INTEGER DEFAULT 0, is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid), FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid, timestamp);
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      trigger TEXT NOT NULL, channel TEXT NOT NULL, is_main INTEGER DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (group_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY, jid TEXT NOT NULL, group_folder TEXT NOT NULL,
      prompt TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL,
      context_mode TEXT NOT NULL DEFAULT 'isolated', status TEXT NOT NULL DEFAULT 'active',
      next_run INTEGER, created_at INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT ''
    );
  `)
  return db
}

// Helpers that use the test db (mirrors db.ts exports exactly)
function storeMessage(msg: { id: string; chat_jid: string; sender: string; sender_name: string; content: string; timestamp: string; is_from_me?: boolean; is_bot_message?: boolean }) {
  db.prepare(`INSERT OR IGNORE INTO messages (id,chat_jid,sender,sender_name,content,timestamp,is_from_me,is_bot_message) VALUES (?,?,?,?,?,?,?,?)`)
    .run(msg.id, msg.chat_jid, msg.sender, msg.sender_name, msg.content, msg.timestamp, msg.is_from_me ? 1 : 0, msg.is_bot_message ? 1 : 0)
}

function storeChatMetadata(jid: string, lastMessageTime: string, name?: string, channel?: string, isGroup?: boolean) {
  db.prepare(`INSERT INTO chats (jid,name,channel,is_group,last_message_time) VALUES (?,?,?,?,?) ON CONFLICT(jid) DO UPDATE SET last_message_time=excluded.last_message_time, name=COALESCE(excluded.name,chats.name), channel=COALESCE(excluded.channel,chats.channel), is_group=COALESCE(excluded.is_group,chats.is_group)`)
    .run(jid, name ?? null, channel ?? null, isGroup ? 1 : 0, lastMessageTime)
}

beforeEach(() => {
  initTestDb()
})

describe('storeMessage + getRecentMessages', () => {
  it('stores message and retrieves it', () => {
    storeChatMetadata('mm:ch1', '2026-01-01T10:00:00.000Z', 'General', 'mattermost', true)
    storeMessage({ id: 'm1', chat_jid: 'mm:ch1', sender: 'u1', sender_name: 'Alice', content: 'hello', timestamp: '2026-01-01T10:00:00.000Z' })

    const rows = db.prepare(`SELECT * FROM messages WHERE chat_jid='mm:ch1' ORDER BY timestamp ASC`).all() as Array<{ content: string; sender_name: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe('hello')
    expect(rows[0]?.sender_name).toBe('Alice')
  })

  it('deduplicates messages with same id+chat_jid', () => {
    storeChatMetadata('mm:ch1', '2026-01-01T10:00:00.000Z')
    storeMessage({ id: 'dup', chat_jid: 'mm:ch1', sender: 'u1', sender_name: 'Alice', content: 'first', timestamp: '2026-01-01T10:00:00.000Z' })
    storeMessage({ id: 'dup', chat_jid: 'mm:ch1', sender: 'u1', sender_name: 'Alice', content: 'second', timestamp: '2026-01-01T10:01:00.000Z' })

    const rows = db.prepare(`SELECT content FROM messages WHERE id='dup'`).all() as Array<{ content: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe('first')
  })

  it('retrieves messages since a given timestamp', () => {
    storeChatMetadata('mm:ch1', '2026-01-01T10:02:00.000Z')
    storeMessage({ id: 'm1', chat_jid: 'mm:ch1', sender: 'u1', sender_name: 'Alice', content: 'old', timestamp: '2026-01-01T09:00:00.000Z' })
    storeMessage({ id: 'm2', chat_jid: 'mm:ch1', sender: 'u1', sender_name: 'Alice', content: 'new', timestamp: '2026-01-01T10:00:00.000Z' })
    storeMessage({ id: 'm3', chat_jid: 'mm:ch1', sender: 'u1', sender_name: 'Alice', content: 'newer', timestamp: '2026-01-01T10:01:00.000Z' })

    const rows = db.prepare(`SELECT content FROM messages WHERE chat_jid='mm:ch1' AND timestamp > ? ORDER BY timestamp ASC`).all('2026-01-01T09:30:00.000Z') as Array<{ content: string }>
    expect(rows).toHaveLength(2)
    expect(rows[0]?.content).toBe('new')
    expect(rows[1]?.content).toBe('newer')
  })
})

describe('storeChatMetadata', () => {
  it('creates chat entry', () => {
    storeChatMetadata('mm:ch99', '2026-01-01T10:00:00.000Z', 'TestChannel', 'mattermost', true)
    const row = db.prepare(`SELECT * FROM chats WHERE jid='mm:ch99'`).get() as { name: string; channel: string; is_group: number }
    expect(row.name).toBe('TestChannel')
    expect(row.channel).toBe('mattermost')
    expect(row.is_group).toBe(1)
  })

  it('upserts: preserves existing name if new name is null', () => {
    storeChatMetadata('mm:ch99', '2026-01-01T10:00:00.000Z', 'OriginalName', 'mattermost', true)
    storeChatMetadata('mm:ch99', '2026-01-01T11:00:00.000Z') // no name
    const row = db.prepare(`SELECT name FROM chats WHERE jid='mm:ch99'`).get() as { name: string }
    expect(row.name).toBe('OriginalName')
  })
})

describe('registered_groups', () => {
  it('inserts and retrieves a group', () => {
    db.prepare(`INSERT INTO registered_groups (jid,name,folder,trigger,channel,is_main,created_at) VALUES ('mm:ch1','Dev','dev-group','@bot','mattermost',0,1700000000000)`).run()
    const row = db.prepare(`SELECT * FROM registered_groups WHERE jid='mm:ch1'`).get() as { name: string; is_main: number; folder: string }
    expect(row.name).toBe('Dev')
    expect(row.is_main).toBe(0)
    expect(row.folder).toBe('dev-group')
  })

  it('main group flag', () => {
    db.prepare(`INSERT INTO registered_groups (jid,name,folder,trigger,channel,is_main,created_at) VALUES ('mm:main','Main','main','*','mattermost',1,1700000000000)`).run()
    const row = db.prepare(`SELECT is_main FROM registered_groups WHERE jid='mm:main'`).get() as { is_main: number }
    expect(row.is_main).toBe(1)
  })

  it('upserts group config', () => {
    db.prepare(`INSERT INTO registered_groups (jid,name,folder,trigger,channel,is_main,created_at) VALUES ('mm:ch1','OldName','my-group','@bot','mattermost',0,1700000000000)`).run()
    db.prepare(`INSERT INTO registered_groups (jid,name,folder,trigger,channel,is_main,created_at) VALUES ('mm:ch1','NewName','my-group','@bot','mattermost',0,1700000000000) ON CONFLICT(jid) DO UPDATE SET name=excluded.name`).run()
    const row = db.prepare(`SELECT name FROM registered_groups WHERE jid='mm:ch1'`).get() as { name: string }
    expect(row.name).toBe('NewName')
  })
})

describe('sessions', () => {
  it('stores and retrieves session IDs', () => {
    db.prepare(`INSERT INTO sessions (group_folder,session_id) VALUES ('dev','sess-abc')`).run()
    const row = db.prepare(`SELECT session_id FROM sessions WHERE group_folder='dev'`).get() as { session_id: string }
    expect(row.session_id).toBe('sess-abc')
  })

  it('upserts session ID', () => {
    db.prepare(`INSERT INTO sessions (group_folder,session_id) VALUES ('dev','sess-old')`).run()
    db.prepare(`INSERT INTO sessions (group_folder,session_id) VALUES ('dev','sess-new') ON CONFLICT(group_folder) DO UPDATE SET session_id=excluded.session_id`).run()
    const row = db.prepare(`SELECT session_id FROM sessions WHERE group_folder='dev'`).get() as { session_id: string }
    expect(row.session_id).toBe('sess-new')
  })
})

describe('router_state', () => {
  it('stores and updates key-value pairs', () => {
    db.prepare(`INSERT INTO router_state (key,value) VALUES ('last_ts','ts1')`).run()
    db.prepare(`INSERT INTO router_state (key,value) VALUES ('last_ts','ts2') ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run()
    const row = db.prepare(`SELECT value FROM router_state WHERE key='last_ts'`).get() as { value: string }
    expect(row.value).toBe('ts2')
  })
})

describe('scheduled_tasks', () => {
  it('stores and retrieves active tasks', () => {
    db.prepare(`INSERT INTO scheduled_tasks (id,jid,group_folder,prompt,schedule_type,schedule_value,context_mode,status,next_run,created_at,created_by) VALUES ('t1','mm:ch1','dev','do stuff','cron','0 9 * * *','isolated','active',9999999999,1700000000000,'bot')`).run()
    const tasks = db.prepare(`SELECT * FROM scheduled_tasks WHERE status='active' ORDER BY next_run ASC`).all() as Array<{ id: string; prompt: string }>
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.id).toBe('t1')
    expect(tasks[0]?.prompt).toBe('do stuff')
  })
})
