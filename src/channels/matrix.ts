// Matrix channel adapter
// JID format: mx:{roomId}  (e.g. mx:!abc123:matrix.org)
// Bot authenticates via MATRIX_HOMESERVER_URL + MATRIX_ACCESS_TOKEN + MATRIX_BOT_USER_ID env vars.

import fs from 'fs';
import path from 'path';

import * as sdk from 'matrix-js-sdk';
import {
  ClientEvent,
  EventType,
  KnownMembership,
  MsgType,
  RoomEvent,
  SyncState,
} from 'matrix-js-sdk';
import type { MatrixEvent, Room } from 'matrix-js-sdk';

import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import { parseCommand } from '../commands.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import {
  Channel,
  GroupConfig,
  NewMessage,
  OnChatMetadata,
  OnCommand,
  OnInboundMessage,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const JID_PREFIX = 'mx:';

export class MatrixChannel implements Channel {
  readonly name = 'matrix';

  private client: sdk.MatrixClient | null = null;
  private connected = false;
  private homeserverUrl: string;
  private accessToken: string;
  private botUserId: string;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private onCommand: OnCommand;
  private registeredGroups: () => Record<string, GroupConfig>;
  private initialSyncDone = false;

  constructor(opts: {
    homeserverUrl: string;
    accessToken: string;
    botUserId: string;
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    onCommand: OnCommand;
    registeredGroups: () => Record<string, GroupConfig>;
  }) {
    this.homeserverUrl = opts.homeserverUrl;
    this.accessToken = opts.accessToken;
    this.botUserId = opts.botUserId;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.onCommand = opts.onCommand;
    this.registeredGroups = opts.registeredGroups;
  }

  async connect(): Promise<void> {
    this.client = sdk.createClient({
      baseUrl: this.homeserverUrl,
      accessToken: this.accessToken,
      userId: this.botUserId,
    });

    // Auto-join rooms when invited
    this.client.on(RoomEvent.MyMembership, (room: Room, membership: string) => {
      if (membership === KnownMembership.Invite) {
        logger.info(
          { roomId: room.roomId },
          'Matrix room invite received, joining',
        );
        this.client
          ?.joinRoom(room.roomId)
          .then(() => {
            logger.info({ roomId: room.roomId }, 'Joined Matrix room');
          })
          .catch((err: unknown) => {
            logger.error(
              { roomId: room.roomId, err },
              'Failed to join Matrix room',
            );
          });
      }
    });

    // Handle incoming messages
    this.client.on(
      RoomEvent.Timeline,
      (
        event: MatrixEvent,
        room: Room | undefined,
        toStartOfTimeline: boolean | undefined,
      ) => {
        // Skip historical events from initial sync / pagination
        if (toStartOfTimeline) return;
        // Skip events before initial sync is done
        if (!this.initialSyncDone) return;

        if (event.getType() !== EventType.RoomMessage) return;

        this.handleRoomMessage(event, room).catch((err: unknown) => {
          logger.error({ err }, 'Matrix message handler error');
        });
      },
    );

    // Wait for initial sync to complete
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Matrix client sync timed out after 30s'));
      }, 30_000);

      this.client!.on(ClientEvent.Sync, (state: SyncState) => {
        if (state === SyncState.Prepared) {
          clearTimeout(timeout);
          this.connected = true;
          this.initialSyncDone = true;
          logger.info(
            { userId: this.botUserId },
            'Matrix client synced and ready',
          );
          resolve();
        }
        if (state === SyncState.Error) {
          clearTimeout(timeout);
          reject(new Error('Matrix sync failed'));
        }
      });

      this.client!.startClient({
        initialSyncLimit: 0,
        lazyLoadMembers: true,
      }).catch((err: unknown) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async handleRoomMessage(
    event: MatrixEvent,
    room: Room | undefined,
  ): Promise<void> {
    const sender = event.getSender();
    if (!sender) return;

    // Ignore own messages
    if (sender === this.botUserId) return;

    const content = event.getContent();
    const msgtype = content.msgtype as string;
    const roomId = room?.roomId ?? event.getRoomId();
    if (!roomId) return;

    const jid = `${JID_PREFIX}${roomId}`;
    const timestamp = new Date(event.getTs()).toISOString();
    const eventId = event.getId() ?? '';

    // Resolve sender display name
    let senderName = sender;
    if (room) {
      const member = room.getMember(sender);
      if (member?.name) {
        senderName = member.name;
      }
    }

    const roomName = room?.name ?? jid;
    const isDm = room ? room.getJoinedMemberCount() === 2 : false;
    const isGroup = !isDm;

    this.onChatMetadata(jid, timestamp, roomName, 'matrix', isGroup);

    // Bot commands — respond even in unregistered rooms (like Telegram's /chatid)
    if (msgtype === MsgType.Text) {
      const body = (content.body as string).trim();

      if (body === '!roomid') {
        await this.client?.sendNotice(
          roomId,
          `Room ID: \`${JID_PREFIX}${roomId}\``,
        );
        return;
      }

      if (body === '!ping') {
        await this.client?.sendNotice(roomId, `${ASSISTANT_NAME} is online.`);
        return;
      }
    }

    // Only deliver to registered groups
    const group = this.registeredGroups()[jid];
    if (!group) {
      logger.debug(
        { jid, roomName, msgtype },
        'Message from unregistered Matrix room',
      );
      return;
    }

    // Orchestrator commands — intercept and forward via onCommand callback
    if (msgtype === MsgType.Text) {
      const command = parseCommand((content.body as string).trim());
      if (command) {
        this.onCommand(jid, command);
        return;
      }
    }

    // Build message content based on msgtype
    let messageContent: string;
    switch (msgtype) {
      case MsgType.Text:
      case MsgType.Notice: {
        messageContent = content.body as string;

        // Translate @bot mentions into @ASSISTANT_NAME format so trigger matching works.
        // Matrix mentions can appear as display name, user ID, or HTML pills.
        if (
          messageContent.includes(this.botUserId) ||
          messageContent.includes(senderName === this.botUserId ? '' : '')
        ) {
          // Check if the bot's user ID or display name is mentioned
          const botDisplayName = room?.getMember(this.botUserId)?.name;
          const isMentioned =
            messageContent.includes(this.botUserId) ||
            (botDisplayName && messageContent.includes(`@${botDisplayName}`));
          if (isMentioned) {
            messageContent = `@${ASSISTANT_NAME} ${messageContent}`;
          }
        }
        break;
      }
      case MsgType.Image: {
        messageContent = await this.handleMediaMessage(
          event,
          group,
          'Photo',
          jid,
        );
        break;
      }
      case MsgType.File: {
        const filename =
          (content.filename as string) ?? (content.body as string) ?? 'file';
        messageContent = await this.handleMediaMessage(
          event,
          group,
          `Document: ${filename}`,
          jid,
        );
        break;
      }
      case MsgType.Video:
        messageContent = '[Video]';
        break;
      case MsgType.Audio: {
        // Matrix voice messages have the org.matrix.msc3245.voice property
        const isVoice =
          'org.matrix.msc3245.voice' in content ||
          'org.matrix.msc1767.audio' in content;

        if (isVoice) {
          messageContent = await this.handleVoiceMessage(event, group, jid);
          // Send transcription as a notice so users see it immediately
          if (messageContent.startsWith('[Voice: ') && this.client && roomId) {
            const transcribedText = messageContent.slice(8, -1);
            this.client
              .sendNotice(roomId, `🎤 ${transcribedText}`)
              .catch((noticeErr: unknown) =>
                logger.debug(
                  { noticeErr },
                  'Failed to send voice transcription notice',
                ),
              );
          }
        } else {
          messageContent = '[Audio]';
        }
        break;
      }
      default:
        messageContent = `[${msgtype ?? 'Unknown message type'}]`;
        break;
    }

    // Append caption for media messages if body differs from filename
    if (
      msgtype === MsgType.Image &&
      content.body &&
      !(content.body as string).match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i)
    ) {
      messageContent += ` ${content.body as string}`;
    }

    const message: NewMessage = {
      id: eventId,
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content: messageContent,
      timestamp,
      is_from_me: false,
    };

    this.onMessage(jid, message);
    logger.info({ jid, roomName, sender: senderName }, 'Matrix message stored');
  }

  /**
   * Download a media file from Matrix and save it to the group's data directory.
   * Returns a placeholder string for the message content.
   */
  private async handleMediaMessage(
    event: MatrixEvent,
    group: GroupConfig,
    label: string,
    jid: string,
  ): Promise<string> {
    const content = event.getContent();
    const mxcUrl = content.url as string | undefined;
    if (!mxcUrl || !this.client) return `[${label}]`;

    try {
      const httpUrl = this.client.mxcUrlToHttp(mxcUrl);
      if (!httpUrl) return `[${label}]`;

      const response = await fetch(httpUrl, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!response.ok) {
        logger.warn(
          { status: response.status, mxcUrl },
          'Failed to download Matrix media',
        );
        return `[${label} - download failed]`;
      }

      const filesDir = path.join(GROUPS_DIR, group.folder, 'matrix', 'files');
      fs.mkdirSync(filesDir, { recursive: true });

      const eventId = event.getId() ?? 'unknown';
      const safeEventId = eventId.replace(/[^a-zA-Z0-9._-]/g, '_');
      const originalName =
        (content.filename as string) ?? (content.body as string) ?? 'file';
      const safeName =
        path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
      const filename = `${safeEventId}_${Date.now()}_${safeName}`;
      const hostPath = path.join(filesDir, filename);
      const containerPath = `/workspace/data/matrix/files/${filename}`;

      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(hostPath, Buffer.from(arrayBuffer));

      logger.info(
        { jid, filename, size: arrayBuffer.byteLength },
        'Matrix media downloaded',
      );

      return `[${label}: ${containerPath}]`;
      // eslint-disable-next-line no-catch-all/no-catch-all -- graceful degradation for media download
    } catch (err) {
      logger.warn(
        { err },
        'Failed to download Matrix media, using placeholder',
      );
      return `[${label} - download failed]`;
    }
  }

  /**
   * Download a voice message from Matrix, transcribe it via STT, and return
   * the transcribed text wrapped as [Voice: ...]. Falls back to [Voice message]
   * if transcription is disabled or fails.
   */
  private async handleVoiceMessage(
    event: MatrixEvent,
    _group: GroupConfig,
    jid: string,
  ): Promise<string> {
    const content = event.getContent();
    const mxcUrl = content.url as string | undefined;
    if (!mxcUrl || !this.client) return '[Voice message]';

    try {
      const httpUrl = this.client.mxcUrlToHttp(mxcUrl);
      if (!httpUrl) return '[Voice message]';

      const response = await fetch(httpUrl, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!response.ok) {
        logger.warn(
          { status: response.status, mxcUrl },
          'Failed to download Matrix voice message',
        );
        return '[Voice message - download failed]';
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);
      const filename =
        (content.body as string)?.replace(/[^a-zA-Z0-9._-]/g, '_') ||
        'voice.ogg';

      const text = await transcribeAudio(audioBuffer, filename);
      if (text) {
        logger.info(
          { jid, chars: text.length },
          'Matrix voice message transcribed',
        );
        return `[Voice: ${text}]`;
      }

      return '[Voice message]';
      // eslint-disable-next-line no-catch-all/no-catch-all -- graceful degradation for voice transcription
    } catch (err) {
      logger.warn(
        { err },
        'Failed to transcribe Matrix voice message, using placeholder',
      );
      return '[Voice message]';
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Matrix client not initialized');
      return;
    }

    try {
      const roomId = jid.replace(JID_PREFIX, '');
      await this.client.sendHtmlMessage(roomId, text, textToHtml(text));
      logger.info({ jid, length: text.length }, 'Matrix message sent');
      // eslint-disable-next-line no-catch-all/no-catch-all -- fire-and-forget delivery
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Matrix message');
    }
  }

  async sendPhoto(
    jid: string,
    source: string,
    caption?: string,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Matrix client not initialized');
      return;
    }

    try {
      const roomId = jid.replace(JID_PREFIX, '');
      let mxcUri: string;

      if (source.startsWith('mxc://')) {
        mxcUri = source;
      } else if (
        source.startsWith('http://') ||
        source.startsWith('https://')
      ) {
        const response = await fetch(source);
        const buffer = Buffer.from(await response.arrayBuffer());
        const upload = await this.client.uploadContent(buffer, {
          name: path.basename(source),
          type: 'image/jpeg',
        });
        mxcUri = upload.content_uri;
      } else {
        const buffer = fs.readFileSync(source);
        const upload = await this.client.uploadContent(buffer, {
          name: path.basename(source),
          type: 'image/jpeg',
        });
        mxcUri = upload.content_uri;
      }

      await this.client.sendMessage(roomId, {
        msgtype: MsgType.Image,
        body: caption ?? path.basename(source),
        url: mxcUri,
        info: { mimetype: 'image/jpeg' },
      });

      logger.info({ jid, source }, 'Matrix photo sent');
      // eslint-disable-next-line no-catch-all/no-catch-all -- fire-and-forget delivery
    } catch (err) {
      logger.error({ jid, source, err }, 'Failed to send Matrix photo');
    }
  }

  async sendDocument(
    jid: string,
    source: string,
    caption?: string,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Matrix client not initialized');
      return;
    }

    try {
      const roomId = jid.replace(JID_PREFIX, '');
      let mxcUri: string;
      const filename = path.basename(source);

      if (source.startsWith('mxc://')) {
        mxcUri = source;
      } else if (
        source.startsWith('http://') ||
        source.startsWith('https://')
      ) {
        const response = await fetch(source);
        const buffer = Buffer.from(await response.arrayBuffer());
        const upload = await this.client.uploadContent(buffer, {
          name: filename,
          type: 'application/octet-stream',
        });
        mxcUri = upload.content_uri;
      } else {
        const buffer = fs.readFileSync(source);
        const upload = await this.client.uploadContent(buffer, {
          name: filename,
          type: 'application/octet-stream',
        });
        mxcUri = upload.content_uri;
      }

      await this.client.sendMessage(roomId, {
        msgtype: MsgType.File,
        body: caption ?? filename,
        filename,
        url: mxcUri,
      });

      logger.info({ jid, source }, 'Matrix document sent');
      // eslint-disable-next-line no-catch-all/no-catch-all -- fire-and-forget delivery
    } catch (err) {
      logger.error({ jid, source, err }, 'Failed to send Matrix document');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.stopClient();
      this.client = null;
      this.connected = false;
      logger.info('Matrix client stopped');
    }
  }

  async sendTyping(jid: string): Promise<void> {
    if (!this.client) return;
    try {
      const roomId = jid.replace(JID_PREFIX, '');
      await this.client.sendTyping(roomId, true, 15_000);
      // eslint-disable-next-line no-catch-all/no-catch-all -- non-critical typing indicator
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Matrix typing indicator');
    }
  }

  async stopTyping(jid: string): Promise<void> {
    if (!this.client) return;
    try {
      const roomId = jid.replace(JID_PREFIX, '');
      await this.client.sendTyping(roomId, false, 0);
      // eslint-disable-next-line no-catch-all/no-catch-all -- non-critical typing indicator
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to stop Matrix typing indicator');
    }
  }
}

/**
 * Convert plain text with basic Markdown to Matrix-compatible HTML.
 * Handles: **bold**, *italic*, `code`, ```code blocks```, [links](url)
 */
function textToHtml(text: string): string {
  // Escape HTML entities first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (```...```)
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

  // Inline code (`...`)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold (**...**)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic (*...*)
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Newlines
  html = html.replace(/\n/g, '<br/>');

  return html;
}

// Auto-register when imported
registerChannel('matrix', (opts: ChannelOpts) => {
  const homeserverUrl = process.env['MATRIX_HOMESERVER_URL'];
  const accessToken = process.env['MATRIX_ACCESS_TOKEN'];
  const botUserId = process.env['MATRIX_BOT_USER_ID'];

  if (!homeserverUrl || !accessToken || !botUserId) {
    logger.warn(
      'MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, or MATRIX_BOT_USER_ID not set — skipping Matrix channel',
    );
    return null;
  }

  return new MatrixChannel({
    homeserverUrl,
    accessToken,
    botUserId,
    onMessage: opts.onMessage,
    onChatMetadata: opts.onChatMetadata,
    onCommand: opts.onCommand,
    registeredGroups: opts.registeredGroups,
  });
});
