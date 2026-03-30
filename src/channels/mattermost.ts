// Mattermost channel adapter
// JID format: mm:{channelId}
// Bot authenticates via Bearer token (MATTERMOST_TOKEN env var)

// @mattermost/client WebSocketClient uses browser globals — polyfill for Node.js 22
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _g = globalThis as any;
if (_g.window === undefined) {
  _g.window = {
    WebSocket: _g.WebSocket,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

import pkg from '@mattermost/client';
const { WebSocketClient } = pkg;
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import { logger } from '../logger.js';
import { ChannelOpts, registerChannel } from './registry.js';

const JID_PREFIX = 'mm:';

interface MattermostPost {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  create_at: number;
  props?: Record<string, unknown>;
  type?: string;
}

interface WebSocketEvent {
  event: string;
  data: Record<string, unknown>;
  broadcast: { channel_id: string; user_id: string; team_id: string };
  seq: number;
}

export class MattermostChannel implements Channel {
  readonly name = 'mattermost';

  private ws: InstanceType<typeof WebSocketClient>;
  private connected = false;
  private botUserId = '';
  private baseUrl: string;
  private token: string;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;

  constructor(opts: {
    baseUrl: string;
    token: string;
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.ws = new WebSocketClient();
  }

  async connect(): Promise<void> {
    // Verify token and get bot user ID
    const me = await this.api<{ id: string; username: string }>(
      '/api/v4/users/me',
    );
    this.botUserId = me.id;
    logger.info(
      { userId: me.id, username: me.username },
      'Mattermost bot authenticated',
    );

    // Set up WebSocket event handler
    this.ws.setEventCallback((event: WebSocketEvent) => {
      this.handleEvent(event).catch((err: unknown) => {
        logger.error({ err }, 'Mattermost WS event error');
      });
    });

    // Connect WebSocket
    const wsUrl = this.baseUrl.replace(/^http/, 'ws');
    await new Promise<void>((resolve, reject) => {
      this.ws.setFirstConnectCallback(() => {
        this.connected = true;
        logger.info('Mattermost WebSocket connected');
        resolve();
      });
      this.ws.setErrorCallback((err: unknown) => {
        logger.error({ err }, 'Mattermost WebSocket error');
        if (!this.connected) reject(err);
      });
      this.ws.initialize(`${wsUrl}/api/v4/websocket`, this.token);
    });
  }

  private async handleEvent(event: WebSocketEvent): Promise<void> {
    if (event.event !== 'posted') return;

    const postJson = event.data['post'] as string | undefined;
    if (!postJson) return;

    let post: MattermostPost;
    try {
      post = JSON.parse(postJson) as MattermostPost;
    } catch (err) {
      if (err instanceof SyntaxError) return;
      throw err;
    }

    // Ignore own messages and system messages
    if (post.user_id === this.botUserId) return;
    if (post.type && post.type !== '') return;

    const channelId = post.channel_id;
    const jid = `${JID_PREFIX}${channelId}`;

    // Resolve sender name
    let senderName = post.user_id;
    try {
      const user = await this.api<{
        username: string;
        first_name: string;
        last_name: string;
      }>(`/api/v4/users/${post.user_id}`);
      senderName =
        [user.first_name, user.last_name].filter(Boolean).join(' ') ||
        user.username;
      // eslint-disable-next-line no-catch-all/no-catch-all -- fallback to user_id when user lookup fails
    } catch {
      // intentionally empty: senderName stays as user_id
    }

    const timestamp = new Date(post.create_at).toISOString();

    this.onChatMetadata(jid, timestamp, undefined, 'mattermost', true);

    const message: NewMessage = {
      id: post.id,
      chat_jid: jid,
      sender: post.user_id,
      sender_name: senderName,
      content: post.message,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    this.onMessage(jid, message);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(JID_PREFIX, '');
    await this.api('/api/v4/posts', 'POST', {
      channel_id: channelId,
      message: text,
    });
  }

  async sendPhoto(
    _jid: string,
    _source: string,
    _caption?: string,
  ): Promise<void> {
    logger.debug('sendPhoto not implemented for Mattermost');
  }

  async sendDocument(
    _jid: string,
    _source: string,
    _caption?: string,
  ): Promise<void> {
    logger.debug('sendDocument not implemented for Mattermost');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.ws.close();
    this.connected = false;
    logger.info('Mattermost disconnected');
  }

  private async api<T = unknown>(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Mattermost API ${method} ${path} → ${res.status}: ${text}`,
      );
    }
    return res.json() as Promise<T>;
  }
}

// Auto-register when imported
registerChannel('mattermost', (opts: ChannelOpts) => {
  const url = process.env['MATTERMOST_URL'];
  const token = process.env['MATTERMOST_TOKEN'];
  if (!url || !token) {
    logger.warn(
      'MATTERMOST_URL or MATTERMOST_TOKEN not set — skipping Mattermost channel',
    );
    return null;
  }
  return new MattermostChannel({
    baseUrl: url,
    token,
    onMessage: opts.onMessage,
    onChatMetadata: opts.onChatMetadata,
  });
});
