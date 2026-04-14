// Shared types between host and agent container

/** Commands handled by the host orchestrator (not channel-local like ping/chatid). */
export type Command = 'new' | 'stop';

export type OnCommand = (chatJid: string, command: Command) => void;

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  /** Full model string, e.g. "anthropic/claude-sonnet-4-6". Passed to agent container config. */
  model: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(jid: string, text: string, options?: SendOptions): Promise<void>;
  sendPhoto?(jid: string, source: string, caption?: string): Promise<void>;
  sendDocument?(jid: string, source: string, caption?: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  sendTyping?(jid: string): Promise<void>;
  stopTyping?(jid: string): Promise<void>;
}

export interface SendOptions {
  replyToId?: string;
}

export interface GroupConfig {
  jid: string;
  folder: string;
  name: string;
  trigger: string;
  channel: string;
  isMain: boolean;
  alwaysRespond: boolean;
  createdAt: number;
  /** Per-group model override. Null/undefined = use global MODEL env var. */
  model?: string | null;
}

export interface ScheduledTask {
  id: string;
  jid: string;
  group_folder: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  status: 'active' | 'paused' | 'completed';
  next_run: number;
  created_at: number;
  created_by: string;
}
