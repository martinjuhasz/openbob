// Telegram channel adapter
// JID format: tg:{chatId}
// Bot authenticates via TELEGRAM_BOT_TOKEN env var, uses grammy for long-polling.

import fs from 'fs';
import path from 'path';

import { Bot, InputFile } from 'grammy';
import type { Api } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  GroupConfig,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const JID_PREFIX = 'tg:';
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    // eslint-disable-next-line no-catch-all/no-catch-all -- Markdown fallback to plain text
  } catch (_err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug(
      { err: _err },
      'Markdown send failed, falling back to plain text',
    );
    await api.sendMessage(chatId, text);
  }
}

/**
 * Download a file from Telegram by its file_id.
 * Returns the file content as a Buffer, or null on failure.
 */
async function downloadTelegramFile(
  botToken: string,
  fileId: string,
): Promise<{ buffer: Buffer; filePath: string } | null> {
  // Resolve file path via Telegram API
  const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const metaRes = await fetch(getFileUrl);
  if (!metaRes.ok) {
    logger.warn({ status: metaRes.status }, 'Telegram getFile API failed');
    return null;
  }

  const json = (await metaRes.json()) as {
    ok: boolean;
    result?: { file_path?: string };
  };
  if (!json.ok || !json.result?.file_path) {
    logger.warn('Telegram getFile returned no file_path');
    return null;
  }

  const filePath = json.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    logger.warn(
      { status: fileRes.status, filePath },
      'Failed to download Telegram file',
    );
    return null;
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), filePath };
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram';

  private bot: Bot | null = null;
  private botToken: string;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private onGroupMigrated: (oldJid: string, newJid: string) => void;
  private registeredGroups: () => Record<string, GroupConfig>;

  constructor(opts: {
    botToken: string;
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    onGroupMigrated: (oldJid: string, newJid: string) => void;
    registeredGroups: () => Record<string, GroupConfig>;
  }) {
    this.botToken = opts.botToken;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.onGroupMigrated = opts.onGroupMigrated;
    this.registeredGroups = opts.registeredGroups;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // /chatid — shows registration ID for the current chat
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : 'title' in ctx.chat
            ? ctx.chat.title || 'Unknown'
            : 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        {
          parse_mode: 'Markdown',
        },
      );
    });

    // /ping — health check
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Handle group → supergroup migration (chat ID changes)
    this.bot.on('message:migrate_to_chat_id', (ctx) => {
      const oldChatId = ctx.chat.id;
      const newChatId = ctx.message.migrate_to_chat_id;
      if (!newChatId) return;

      const oldJid = `${JID_PREFIX}${oldChatId}`;
      const newJid = `${JID_PREFIX}${newChatId}`;

      logger.info({ oldJid, newJid }, 'Telegram group migrated to supergroup');

      this.onGroupMigrated(oldJid, newJid);
    });

    // Bot commands that should NOT flow through to the general message handler
    const BOT_COMMANDS = new Set(['chatid', 'ping']);

    // --- Text messages ---
    this.bot.on('message:text', async (ctx) => {
      // Skip bot commands already handled above
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `${JID_PREFIX}${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        String(ctx.from?.id) ||
        'Unknown';
      const sender = String(ctx.from?.id ?? '');
      const msgId = String(ctx.message.message_id);

      // Translate @bot_username mentions into @ASSISTANT_NAME format so trigger matching works.
      // Telegram @mentions (e.g., @my_bot) won't match the group trigger pattern directly.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : 'title' in ctx.chat
            ? ctx.chat.title || chatJid
            : chatJid;
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

      // Only deliver to registered groups
      const group = this.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      const message: NewMessage = {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      };
      this.onMessage(chatJid, message);
      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // --- Helper: store a non-text message with a placeholder ---
    const storeNonText = (
      ctx: {
        chat: { id: number; type: string };
        from?: { first_name?: string; username?: string; id?: number };
        message: { date: number; message_id: number; caption?: string };
      },
      placeholder: string,
    ) => {
      const chatJid = `${JID_PREFIX}${ctx.chat.id}`;
      const group = this.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        String(ctx.from?.id ?? '') ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);
      this.onMessage(chatJid, {
        id: String(ctx.message.message_id),
        chat_jid: chatJid,
        sender: String(ctx.from?.id ?? ''),
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    // --- Photos: download to shared data dir so agent can view them ---
    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `${JID_PREFIX}${ctx.chat.id}`;
      const group = this.registeredGroups()[chatJid];

      if (!group) {
        storeNonText(ctx, '[Photo]');
        return;
      }

      try {
        const photos = ctx.message.photo;
        if (!photos?.length) {
          storeNonText(ctx, '[Photo]');
          return;
        }
        // Use the highest resolution variant (last element)
        const photo = photos[photos.length - 1];

        // Save to groups/<group>/telegram/files/ (visible at /workspace/data/telegram/files/ in agent)
        const filesDir = path.join(
          GROUPS_DIR,
          group.folder,
          'telegram',
          'files',
        );
        fs.mkdirSync(filesDir, { recursive: true });

        const filename = `photo_${ctx.message.message_id}_${Date.now()}.jpg`;
        const hostPath = path.join(filesDir, filename);
        const containerPath = `/workspace/data/telegram/files/${filename}`;

        const result = await downloadTelegramFile(this.botToken, photo.file_id);
        if (result) {
          fs.writeFileSync(hostPath, result.buffer);
          logger.info(
            { chatJid, filename, size: photo.file_size },
            'Telegram photo downloaded',
          );
          storeNonText(ctx, `[Photo: ${containerPath}]`);
        } else {
          storeNonText(ctx, '[Photo - download failed]');
        }
        // eslint-disable-next-line no-catch-all/no-catch-all -- graceful degradation for photo download
      } catch (err) {
        logger.warn(
          { err },
          'Failed to download Telegram photo, using placeholder',
        );
        storeNonText(ctx, '[Photo - download failed]');
      }
    });

    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `${JID_PREFIX}${ctx.chat.id}`;
      const group = this.registeredGroups()[chatJid];
      const docName = ctx.message.document?.file_name || 'file';
      // Sanitize user-supplied filename: strip path components, allow only safe chars
      const safeDocName =
        path.basename(docName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';

      if (!group) {
        storeNonText(ctx, `[Document: ${safeDocName}]`);
        return;
      }

      try {
        const fileId = ctx.message.document?.file_id;
        if (!fileId) {
          storeNonText(ctx, `[Document: ${safeDocName}]`);
          return;
        }

        const filesDir = path.join(
          GROUPS_DIR,
          group.folder,
          'telegram',
          'files',
        );
        fs.mkdirSync(filesDir, { recursive: true });

        const filename = `doc_${ctx.message.message_id}_${Date.now()}_${safeDocName}`;
        const hostPath = path.join(filesDir, filename);
        const containerPath = `/workspace/data/telegram/files/${filename}`;

        const result = await downloadTelegramFile(this.botToken, fileId);
        if (result) {
          fs.writeFileSync(hostPath, result.buffer);
          logger.info(
            { chatJid, filename, size: ctx.message.document?.file_size },
            'Telegram document downloaded',
          );
          storeNonText(ctx, `[Document: ${containerPath}]`);
        } else {
          storeNonText(ctx, `[Document: ${safeDocName} - download failed]`);
        }
        // eslint-disable-next-line no-catch-all/no-catch-all -- graceful degradation for document download
      } catch (err) {
        logger.warn(
          { err },
          'Failed to download Telegram document, using placeholder',
        );
        storeNonText(ctx, `[Document: ${safeDocName} - download failed]`);
      }
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Global error handler
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start long-polling
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Telegram bot start timed out after 30s'));
      }, 30_000);

      this.bot!.start({
        onStart: (botInfo) => {
          clearTimeout(timeout);
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          resolve();
        },
      }).catch((err: unknown) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(JID_PREFIX, '');

      if (text.length <= MAX_MESSAGE_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        // Split long messages into 4096-char chunks
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_MESSAGE_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
      // eslint-disable-next-line no-catch-all/no-catch-all -- fire-and-forget delivery
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendPhoto(
    jid: string,
    source: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(JID_PREFIX, '');
      const options = caption ? { caption } : {};

      if (source.startsWith('http://') || source.startsWith('https://')) {
        await this.bot.api.sendPhoto(numericId, source, options);
      } else {
        const fileStream = fs.createReadStream(source);
        const filename = path.basename(source);
        await this.bot.api.sendPhoto(
          numericId,
          new InputFile(fileStream, filename),
          options,
        );
      }
      logger.info({ jid, source }, 'Telegram photo sent');
      // eslint-disable-next-line no-catch-all/no-catch-all -- fire-and-forget delivery
    } catch (err) {
      logger.error({ jid, source, err }, 'Failed to send Telegram photo');
    }
  }

  async sendDocument(
    jid: string,
    source: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(JID_PREFIX, '');
      const options = caption ? { caption } : {};

      if (source.startsWith('http://') || source.startsWith('https://')) {
        await this.bot.api.sendDocument(numericId, source, options);
      } else {
        const fileStream = fs.createReadStream(source);
        const filename = path.basename(source);
        await this.bot.api.sendDocument(
          numericId,
          new InputFile(fileStream, filename),
          options,
        );
      }
      logger.info({ jid, source }, 'Telegram document sent');
      // eslint-disable-next-line no-catch-all/no-catch-all -- fire-and-forget delivery
    } catch (err) {
      logger.error({ jid, source, err }, 'Failed to send Telegram document');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async sendTyping(jid: string): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(JID_PREFIX, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
      // eslint-disable-next-line no-catch-all/no-catch-all -- non-critical typing indicator
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

// Auto-register when imported
registerChannel('telegram', (opts: ChannelOpts) => {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) {
    logger.warn('TELEGRAM_BOT_TOKEN not set — skipping Telegram channel');
    return null;
  }
  return new TelegramChannel({
    botToken: token,
    onMessage: opts.onMessage,
    onChatMetadata: opts.onChatMetadata,
    onGroupMigrated: opts.onGroupMigrated,
    registeredGroups: opts.registeredGroups,
  });
});
