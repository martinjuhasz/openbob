import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- grammy mock -------------------------------------------------------
// vi.hoisted ensures the mock classes are available when vi.mock factory runs
const {
  MockBot,
  mockApi,
  registerChannelSpy,
  mockCreateReadStream,
  mockMkdirSync,
  mockWriteFileSync,
  mockFetch,
} = vi.hoisted(() => {
  const mockApi = {
    sendMessage: vi.fn().mockResolvedValue({}),
    sendPhoto: vi.fn().mockResolvedValue({}),
    sendDocument: vi.fn().mockResolvedValue({}),
    sendChatAction: vi.fn().mockResolvedValue(true),
  };

  class MockBot {
    api = mockApi;
    command = vi.fn();
    on = vi.fn();
    catch = vi.fn();
    start = vi
      .fn()
      .mockImplementation(
        (opts?: {
          onStart?: (info: { username: string; id: number }) => void;
        }) => {
          opts?.onStart?.({ username: 'test_bot', id: 12345 });
          return Promise.resolve();
        },
      );
    stop = vi.fn();
  }

  // Capture registerChannel calls before clearAllMocks
  const registerChannelSpy = vi.fn();

  // fs mocks — need to survive clearAllMocks via hoisting
  const mockCreateReadStream = vi
    .fn()
    .mockReturnValue({ pipe: vi.fn() } as unknown);
  const mockMkdirSync = vi.fn();
  const mockWriteFileSync = vi.fn();

  // Global fetch mock for downloadTelegramFile
  const mockFetch = vi.fn();

  return {
    MockBot,
    mockApi,
    registerChannelSpy,
    mockCreateReadStream,
    mockMkdirSync,
    mockWriteFileSync,
    mockFetch,
  };
});

vi.mock('grammy', () => ({
  Bot: MockBot,
  InputFile: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    source: unknown,
    filename: string,
  ) {
    this.source = source;
    this.filename = filename;
  }),
}));

// Mock fs — only override createReadStream, mkdirSync, writeFileSync
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<
    Record<string, unknown> & typeof import('fs')
  >();
  const defaultExport =
    (actual.default as Record<string, unknown> | undefined) ?? actual;
  return {
    ...actual,
    default: {
      ...defaultExport,
      createReadStream: mockCreateReadStream,
      mkdirSync: mockMkdirSync,
      writeFileSync: mockWriteFileSync,
    },
    createReadStream: mockCreateReadStream,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
  };
});

// Mock logger
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock registry — capture the call for later verification
vi.mock('./registry.js', () => ({
  registerChannel: registerChannelSpy,
}));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'yetaclaw',
  DATA_DIR: '/test-data',
}));

import { TelegramChannel } from './telegram.js';
import { GroupConfig } from '../types.js';

const baseOpts = {
  botToken: 'test-bot-token',
  onMessage: vi.fn(),
  onChatMetadata: vi.fn(),
  onGroupMigrated: vi.fn(),
  registeredGroups: vi.fn().mockReturnValue({} as Record<string, GroupConfig>),
};

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  describe('ownsJid', () => {
    it('claims JIDs starting with tg:', () => {
      const ch = new TelegramChannel(baseOpts);
      expect(ch.ownsJid('tg:-1001234567890')).toBe(true);
      expect(ch.ownsJid('tg:123')).toBe(true);
    });

    it('rejects JIDs from other channels', () => {
      const ch = new TelegramChannel(baseOpts);
      expect(ch.ownsJid('mm:abc123')).toBe(false);
      expect(ch.ownsJid('dc:1234')).toBe(false);
      expect(ch.ownsJid('anything-else')).toBe(false);
    });
  });

  describe('name', () => {
    it('is "telegram"', () => {
      const ch = new TelegramChannel(baseOpts);
      expect(ch.name).toBe('telegram');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect()', () => {
      const ch = new TelegramChannel(baseOpts);
      expect(ch.isConnected()).toBe(false);
    });

    it('returns true after connect()', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();
      expect(ch.isConnected()).toBe(true);
    });

    it('returns false after disconnect()', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();
      await ch.disconnect();
      expect(ch.isConnected()).toBe(false);
    });
  });

  describe('connect', () => {
    it('creates Bot and starts long-polling', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      // Bot.start should have been called
      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      expect(bot.start).toHaveBeenCalledOnce();
    });

    it('registers /chatid and /ping commands', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      expect(bot.command).toHaveBeenCalledWith('chatid', expect.any(Function));
      expect(bot.command).toHaveBeenCalledWith('ping', expect.any(Function));
    });

    it('registers message handlers for all content types', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      const registeredTypes = bot.on.mock.calls.map(
        (call: unknown[]) => call[0],
      );

      expect(registeredTypes).toContain('message:text');
      expect(registeredTypes).toContain('message:photo');
      expect(registeredTypes).toContain('message:video');
      expect(registeredTypes).toContain('message:voice');
      expect(registeredTypes).toContain('message:audio');
      expect(registeredTypes).toContain('message:document');
      expect(registeredTypes).toContain('message:sticker');
      expect(registeredTypes).toContain('message:location');
      expect(registeredTypes).toContain('message:contact');
    });

    it('registers a global error handler', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      expect(bot.catch).toHaveBeenCalledOnce();
    });
  });

  describe('sendMessage', () => {
    it('sends a short message via Telegram API with Markdown', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      await ch.sendMessage('tg:123456', 'Hello World');

      expect(mockApi.sendMessage).toHaveBeenCalledOnce();
      expect(mockApi.sendMessage).toHaveBeenCalledWith(
        '123456',
        'Hello World',
        {
          parse_mode: 'Markdown',
        },
      );
    });

    it('strips tg: prefix from JID', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      await ch.sendMessage('tg:-1001234567890', 'test');

      const chatId = mockApi.sendMessage.mock.calls[0]?.[0];
      expect(chatId).toBe('-1001234567890');
    });

    it('splits long messages into 4096-char chunks', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      const longText = 'A'.repeat(5000);
      await ch.sendMessage('tg:123', longText);

      // 5000 chars should be split into 2 chunks: 4096 + 904
      expect(mockApi.sendMessage).toHaveBeenCalledTimes(2);
      const firstChunk = mockApi.sendMessage.mock.calls[0]?.[1] as string;
      const secondChunk = mockApi.sendMessage.mock.calls[1]?.[1] as string;
      expect(firstChunk).toHaveLength(4096);
      expect(secondChunk).toHaveLength(904);
    });

    it('falls back to plain text when Markdown fails', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      // First call (Markdown) fails, second call (plain text) succeeds
      mockApi.sendMessage
        .mockRejectedValueOnce(new Error('Bad Request: parse error'))
        .mockResolvedValueOnce({});

      await ch.sendMessage('tg:123', 'bad *markdown');

      expect(mockApi.sendMessage).toHaveBeenCalledTimes(2);
      // First attempt with Markdown
      expect(mockApi.sendMessage.mock.calls[0]?.[2]).toEqual({
        parse_mode: 'Markdown',
      });
      // Second attempt without parse_mode
      expect(mockApi.sendMessage.mock.calls[1]?.[2]).toBeUndefined();
    });

    it('does nothing if bot is not initialized', async () => {
      const ch = new TelegramChannel(baseOpts);
      // No connect() call
      await ch.sendMessage('tg:123', 'test');
      expect(mockApi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendPhoto', () => {
    it('sends a photo by URL', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      await ch.sendPhoto(
        'tg:123',
        'https://example.com/photo.jpg',
        'A caption',
      );

      expect(mockApi.sendPhoto).toHaveBeenCalledOnce();
      expect(mockApi.sendPhoto).toHaveBeenCalledWith(
        '123',
        'https://example.com/photo.jpg',
        { caption: 'A caption' },
      );
    });

    it('sends a photo by file path using InputFile', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      await ch.sendPhoto('tg:123', '/tmp/photo.jpg');

      expect(mockApi.sendPhoto).toHaveBeenCalledOnce();
      // First arg: chat ID, second arg: InputFile instance, third: options
      const args = mockApi.sendPhoto.mock.calls[0];
      expect(args?.[0]).toBe('123');
      // InputFile is mocked — just verify it was called with the stream
      expect(args?.[1]).toBeDefined();
    });

    it('sends without caption when not provided', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      await ch.sendPhoto('tg:123', 'https://example.com/photo.jpg');

      const options = mockApi.sendPhoto.mock.calls[0]?.[2];
      expect(options).toEqual({});
    });

    it('does nothing if bot is not initialized', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.sendPhoto('tg:123', 'https://example.com/photo.jpg');
      expect(mockApi.sendPhoto).not.toHaveBeenCalled();
    });
  });

  describe('sendDocument', () => {
    it('sends a document by URL', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      await ch.sendDocument('tg:123', 'https://example.com/file.pdf', 'Report');

      expect(mockApi.sendDocument).toHaveBeenCalledOnce();
      expect(mockApi.sendDocument).toHaveBeenCalledWith(
        '123',
        'https://example.com/file.pdf',
        { caption: 'Report' },
      );
    });

    it('sends a document by file path using InputFile', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      await ch.sendDocument('tg:123', '/tmp/report.pdf');

      expect(mockApi.sendDocument).toHaveBeenCalledOnce();
      const args = mockApi.sendDocument.mock.calls[0];
      expect(args?.[0]).toBe('123');
      expect(args?.[1]).toBeDefined();
    });

    it('does nothing if bot is not initialized', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.sendDocument('tg:123', 'https://example.com/file.pdf');
      expect(mockApi.sendDocument).not.toHaveBeenCalled();
    });
  });

  describe('sendTyping', () => {
    it('sends typing action to Telegram', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      await ch.sendTyping('tg:123456');

      expect(mockApi.sendChatAction).toHaveBeenCalledOnce();
      expect(mockApi.sendChatAction).toHaveBeenCalledWith('123456', 'typing');
    });

    it('strips tg: prefix from JID', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      await ch.sendTyping('tg:-1001234567890');

      const chatId = mockApi.sendChatAction.mock.calls[0]?.[0];
      expect(chatId).toBe('-1001234567890');
    });

    it('does nothing if bot is not initialized', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.sendTyping('tg:123');
      expect(mockApi.sendChatAction).not.toHaveBeenCalled();
    });

    it('does not throw when sendChatAction fails', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();

      mockApi.sendChatAction.mockRejectedValueOnce(new Error('network error'));

      // Should not throw
      await expect(ch.sendTyping('tg:123')).resolves.toBeUndefined();
    });
  });

  describe('disconnect', () => {
    it('stops the bot', async () => {
      const ch = new TelegramChannel(baseOpts);
      await ch.connect();
      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;

      await ch.disconnect();

      expect(bot.stop).toHaveBeenCalledOnce();
      expect(ch.isConnected()).toBe(false);
    });

    it('does nothing if already disconnected', async () => {
      const ch = new TelegramChannel(baseOpts);
      // Never connected, so no bot to stop
      await ch.disconnect();
      // Should not throw
    });
  });

  describe('message:text handler', () => {
    it('stores text messages for registered groups', async () => {
      const groups: Record<string, GroupConfig> = {
        'tg:999': {
          jid: 'tg:999',
          folder: 'test',
          name: 'Test',
          trigger: 'yetaclaw',
          channel: 'telegram',
          isMain: false,
          alwaysRespond: false,
          createdAt: Date.now(),
        },
      };
      const onMessage = vi.fn();
      const onChatMetadata = vi.fn();
      const ch = new TelegramChannel({
        ...baseOpts,
        onMessage,
        onChatMetadata,
        registeredGroups: () => groups,
      });
      await ch.connect();

      // Find the message:text handler
      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      const textHandler = bot.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message:text',
      )?.[1] as (ctx: unknown) => Promise<void>;

      const ctx = {
        chat: { id: 999, type: 'group', title: 'Test Group' },
        from: { id: 42, first_name: 'Alice', username: 'alice' },
        message: {
          text: 'Hello everyone',
          date: Math.floor(Date.now() / 1000),
          message_id: 1001,
          entities: [],
        },
        me: { username: 'test_bot' },
      };
      await textHandler(ctx);

      expect(onChatMetadata).toHaveBeenCalledWith(
        'tg:999',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({
          id: '1001',
          chat_jid: 'tg:999',
          sender: '42',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('ignores messages from unregistered chats', async () => {
      const onMessage = vi.fn();
      const ch = new TelegramChannel({
        ...baseOpts,
        onMessage,
        registeredGroups: () => ({}),
      });
      await ch.connect();

      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      const textHandler = bot.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message:text',
      )?.[1] as (ctx: unknown) => Promise<void>;

      await textHandler({
        chat: { id: 999, type: 'private' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          text: 'Hello',
          date: Math.floor(Date.now() / 1000),
          message_id: 1,
          entities: [],
        },
        me: { username: 'test_bot' },
      });

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('translates @bot mention into @ASSISTANT_NAME prefix', async () => {
      const groups: Record<string, GroupConfig> = {
        'tg:999': {
          jid: 'tg:999',
          folder: 'test',
          name: 'Test',
          trigger: 'yetaclaw',
          channel: 'telegram',
          isMain: false,
          alwaysRespond: false,
          createdAt: Date.now(),
        },
      };
      const onMessage = vi.fn();
      const ch = new TelegramChannel({
        ...baseOpts,
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => groups,
      });
      await ch.connect();

      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      const textHandler = bot.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message:text',
      )?.[1] as (ctx: unknown) => Promise<void>;

      await textHandler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          text: '@test_bot what is the weather?',
          date: Math.floor(Date.now() / 1000),
          message_id: 2,
          entities: [{ type: 'mention', offset: 0, length: 9 }],
        },
        me: { username: 'test_bot' },
      });

      const storedContent = onMessage.mock.calls[0]?.[1]?.content as string;
      expect(storedContent).toMatch(/^@yetaclaw /);
    });

    it('skips /chatid and /ping bot commands', async () => {
      const onMessage = vi.fn();
      const ch = new TelegramChannel({
        ...baseOpts,
        onMessage,
        registeredGroups: () => ({
          'tg:999': {
            jid: 'tg:999',
            folder: 'test',
            name: 'Test',
            trigger: 'yetaclaw',
            channel: 'telegram',
            isMain: false,
            alwaysRespond: false,
            createdAt: Date.now(),
          },
        }),
      });
      await ch.connect();

      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      const textHandler = bot.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message:text',
      )?.[1] as (ctx: unknown) => Promise<void>;

      // /chatid should be skipped
      await textHandler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          text: '/chatid',
          date: Math.floor(Date.now() / 1000),
          message_id: 1,
          entities: [],
        },
        me: { username: 'test_bot' },
      });

      // /ping should be skipped
      await textHandler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          text: '/ping',
          date: Math.floor(Date.now() / 1000),
          message_id: 2,
          entities: [],
        },
        me: { username: 'test_bot' },
      });

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('passes through non-bot slash commands as regular messages', async () => {
      const onMessage = vi.fn();
      const ch = new TelegramChannel({
        ...baseOpts,
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({
          'tg:999': {
            jid: 'tg:999',
            folder: 'test',
            name: 'Test',
            trigger: 'yetaclaw',
            channel: 'telegram',
            isMain: false,
            alwaysRespond: false,
            createdAt: Date.now(),
          },
        }),
      });
      await ch.connect();

      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      const textHandler = bot.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message:text',
      )?.[1] as (ctx: unknown) => Promise<void>;

      await textHandler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          text: '/help me',
          date: Math.floor(Date.now() / 1000),
          message_id: 3,
          entities: [],
        },
        me: { username: 'test_bot' },
      });

      expect(onMessage).toHaveBeenCalledOnce();
    });

    it('uses sender first_name as chat name for private chats', async () => {
      const onChatMetadata = vi.fn();
      const ch = new TelegramChannel({
        ...baseOpts,
        onMessage: vi.fn(),
        onChatMetadata,
        registeredGroups: () => ({
          'tg:42': {
            jid: 'tg:42',
            folder: 'dm',
            name: 'DM',
            trigger: 'yetaclaw',
            channel: 'telegram',
            isMain: false,
            alwaysRespond: true,
            createdAt: Date.now(),
          },
        }),
      });
      await ch.connect();

      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      const textHandler = bot.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message:text',
      )?.[1] as (ctx: unknown) => Promise<void>;

      await textHandler({
        chat: { id: 42, type: 'private' },
        from: { id: 42, first_name: 'Bob' },
        message: {
          text: 'Hello',
          date: Math.floor(Date.now() / 1000),
          message_id: 1,
          entities: [],
        },
        me: { username: 'test_bot' },
      });

      expect(onChatMetadata).toHaveBeenCalledWith(
        'tg:42',
        expect.any(String),
        'Bob',
        'telegram',
        false,
      );
    });
  });

  describe('non-text message handlers', () => {
    async function getNonTextHandler(
      contentType: string,
      groups: Record<string, GroupConfig> = {},
    ) {
      const onMessage = vi.fn();
      const ch = new TelegramChannel({
        ...baseOpts,
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => groups,
      });
      await ch.connect();
      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      const handler = bot.on.mock.calls.find(
        (c: unknown[]) => c[0] === contentType,
      )?.[1] as (ctx: unknown) => Promise<void> | void;
      return { handler, onMessage };
    }

    const group: GroupConfig = {
      jid: 'tg:999',
      folder: 'test',
      name: 'Test',
      trigger: 'yetaclaw',
      channel: 'telegram',
      isMain: false,
      alwaysRespond: false,
      createdAt: Date.now(),
    };
    const groups = { 'tg:999': group };

    const baseCtx = {
      chat: { id: 999, type: 'group', title: 'Test' },
      from: { id: 42, first_name: 'Alice' },
      message: { date: Math.floor(Date.now() / 1000), message_id: 10 },
    };

    it('stores [Video] placeholder', async () => {
      const { handler, onMessage } = await getNonTextHandler(
        'message:video',
        groups,
      );
      await handler(baseCtx);
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('stores [Voice message] placeholder', async () => {
      const { handler, onMessage } = await getNonTextHandler(
        'message:voice',
        groups,
      );
      await handler(baseCtx);
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({ content: '[Voice message]' }),
      );
    });

    it('stores [Audio] placeholder', async () => {
      const { handler, onMessage } = await getNonTextHandler(
        'message:audio',
        groups,
      );
      await handler(baseCtx);
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('stores [Document: filename] placeholder', async () => {
      const { handler, onMessage } = await getNonTextHandler(
        'message:document',
        groups,
      );
      await handler({
        ...baseCtx,
        message: { ...baseCtx.message, document: { file_name: 'report.pdf' } },
      });
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({ content: '[Document: report.pdf]' }),
      );
    });

    it('stores [Sticker emoji] placeholder', async () => {
      const { handler, onMessage } = await getNonTextHandler(
        'message:sticker',
        groups,
      );
      await handler({
        ...baseCtx,
        message: { ...baseCtx.message, sticker: { emoji: '😀' } },
      });
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({ content: '[Sticker 😀]' }),
      );
    });

    it('stores [Location] placeholder', async () => {
      const { handler, onMessage } = await getNonTextHandler(
        'message:location',
        groups,
      );
      await handler(baseCtx);
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores [Contact] placeholder', async () => {
      const { handler, onMessage } = await getNonTextHandler(
        'message:contact',
        groups,
      );
      await handler(baseCtx);
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('includes caption in placeholder messages', async () => {
      const { handler, onMessage } = await getNonTextHandler(
        'message:video',
        groups,
      );
      await handler({
        ...baseCtx,
        message: { ...baseCtx.message, caption: 'Check this out' },
      });
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({
          content: '[Video] Check this out',
        }),
      );
    });

    it('does not store non-text for unregistered chats', async () => {
      const { handler, onMessage } = await getNonTextHandler(
        'message:video',
        {},
      );
      await handler(baseCtx);
      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  describe('photo download handler', () => {
    const group: GroupConfig = {
      jid: 'tg:999',
      folder: 'test',
      name: 'Test',
      trigger: 'yetaclaw',
      channel: 'telegram',
      isMain: false,
      alwaysRespond: false,
      createdAt: Date.now(),
    };
    const groups = { 'tg:999': group };

    async function getPhotoHandler(g: Record<string, GroupConfig> = groups) {
      const onMessage = vi.fn();
      const ch = new TelegramChannel({
        ...baseOpts,
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => g,
      });
      await ch.connect();
      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      const handler = bot.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message:photo',
      )?.[1] as (ctx: unknown) => Promise<void>;
      return { handler, onMessage };
    }

    function mockSuccessfulDownload() {
      const fileBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      mockFetch
        // First call: getFile API
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { file_path: 'photos/file_42.jpg' },
            }),
        })
        // Second call: file download
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(fileBytes.buffer),
        });
      return fileBytes;
    }

    it('downloads photo, saves to data dir, and stores container path', async () => {
      const fileBytes = mockSuccessfulDownload();
      const { handler, onMessage } = await getPhotoHandler();

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 50,
          photo: [
            { file_id: 'small_id', width: 90, height: 90 },
            { file_id: 'large_id', width: 800, height: 600, file_size: 12345 },
          ],
        },
      });

      // Should call getFile API with the largest photo (last element)
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const getFileUrl = mockFetch.mock.calls[0]?.[0] as string;
      expect(getFileUrl).toContain('file_id=large_id');
      expect(getFileUrl).toContain('bot' + 'test-bot-token');

      // Should create the directory
      expect(mockMkdirSync).toHaveBeenCalledWith('/test-data/telegram/files', {
        recursive: true,
      });

      // Should write the file with correct content
      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const writePath = mockWriteFileSync.mock.calls[0]?.[0] as string;
      expect(writePath).toMatch(/^\/test-data\/telegram\/files\/photo_50_/);
      expect(writePath).toMatch(/\.jpg$/);
      const writtenBuffer = mockWriteFileSync.mock.calls[0]?.[1] as Buffer;
      expect([...writtenBuffer]).toEqual([...fileBytes]);

      // Message content should reference container path
      const content = onMessage.mock.calls[0]?.[1]?.content as string;
      expect(content).toMatch(
        /^\[Photo: \/workspace\/data\/telegram\/files\/photo_50_\d+\.jpg\]$/,
      );
    });

    it('stores failure placeholder when getFile API fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      const { handler, onMessage } = await getPhotoHandler();

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 51,
          photo: [{ file_id: 'some_id', width: 800, height: 600 }],
        },
      });

      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({ content: '[Photo - download failed]' }),
      );
    });

    it('stores failure placeholder when file download fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { file_path: 'photos/file.jpg' },
            }),
        })
        .mockResolvedValueOnce({ ok: false, status: 404 });

      const { handler, onMessage } = await getPhotoHandler();

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 52,
          photo: [{ file_id: 'some_id', width: 800, height: 600 }],
        },
      });

      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({ content: '[Photo - download failed]' }),
      );
    });

    it('stores plain [Photo] when photo array is empty', async () => {
      const { handler, onMessage } = await getPhotoHandler();

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 53,
          photo: [],
        },
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('includes caption with downloaded photo', async () => {
      mockSuccessfulDownload();
      const { handler, onMessage } = await getPhotoHandler();

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 54,
          caption: 'Look at this',
          photo: [{ file_id: 'pic_id', width: 800, height: 600 }],
        },
      });

      const content = onMessage.mock.calls[0]?.[1]?.content as string;
      expect(content).toMatch(/^\[Photo: \/workspace\/data\/telegram\/files\//);
      expect(content).toContain('Look at this');
    });

    it('stores [Photo] placeholder for unregistered groups', async () => {
      const { handler, onMessage } = await getPhotoHandler({});

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 55,
          photo: [{ file_id: 'pic_id', width: 800, height: 600 }],
        },
      });

      // Should not attempt download for unregistered group
      expect(mockFetch).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('handles fetch exception gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network error'));
      const { handler, onMessage } = await getPhotoHandler();

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 56,
          photo: [{ file_id: 'pic_id', width: 800, height: 600 }],
        },
      });

      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({ content: '[Photo - download failed]' }),
      );
    });
  });

  describe('document download handler', () => {
    const group: GroupConfig = {
      jid: 'tg:999',
      folder: 'test',
      name: 'Test',
      trigger: 'yetaclaw',
      channel: 'telegram',
      isMain: false,
      alwaysRespond: false,
      createdAt: Date.now(),
    };
    const groups = { 'tg:999': group };

    async function getDocHandler(g: Record<string, GroupConfig> = groups) {
      const onMessage = vi.fn();
      const ch = new TelegramChannel({
        ...baseOpts,
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => g,
      });
      await ch.connect();
      const bot = (ch as unknown as { bot: InstanceType<typeof MockBot> }).bot;
      const handler = bot.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message:document',
      )?.[1] as (ctx: unknown) => Promise<void>;
      return { handler, onMessage };
    }

    function mockSuccessfulDownload() {
      const fileBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { file_path: 'documents/file_99.pdf' },
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(fileBytes.buffer),
        });
      return fileBytes;
    }

    it('downloads document, saves to data dir, and stores container path', async () => {
      const fileBytes = mockSuccessfulDownload();
      const { handler, onMessage } = await getDocHandler();

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 60,
          document: {
            file_id: 'doc_file_id',
            file_name: 'report.pdf',
            file_size: 5000,
          },
        },
      });

      // Should call getFile API
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const getFileUrl = mockFetch.mock.calls[0]?.[0] as string;
      expect(getFileUrl).toContain('file_id=doc_file_id');

      // Should create directory and write file
      expect(mockMkdirSync).toHaveBeenCalledWith('/test-data/telegram/files', {
        recursive: true,
      });
      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const writePath = mockWriteFileSync.mock.calls[0]?.[0] as string;
      expect(writePath).toMatch(
        /^\/test-data\/telegram\/files\/doc_60_\d+_report\.pdf$/,
      );
      const writtenBuffer = mockWriteFileSync.mock.calls[0]?.[1] as Buffer;
      expect([...writtenBuffer]).toEqual([...fileBytes]);

      // Message should reference container path
      const content = onMessage.mock.calls[0]?.[1]?.content as string;
      expect(content).toMatch(
        /^\[Document: \/workspace\/data\/telegram\/files\/doc_60_\d+_report\.pdf\]$/,
      );
    });

    it('stores failure placeholder when download fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      const { handler, onMessage } = await getDocHandler();

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 61,
          document: {
            file_id: 'doc_id',
            file_name: 'report.pdf',
          },
        },
      });

      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({
          content: '[Document: report.pdf - download failed]',
        }),
      );
    });

    it('stores plain placeholder when document has no file_id', async () => {
      const { handler, onMessage } = await getDocHandler();

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 62,
          document: { file_name: 'readme.txt' },
        },
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({ content: '[Document: readme.txt]' }),
      );
    });

    it('uses "file" as default name when file_name is missing', async () => {
      mockSuccessfulDownload();
      const { handler, onMessage } = await getDocHandler();

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 63,
          document: { file_id: 'doc_id' },
        },
      });

      const writePath = mockWriteFileSync.mock.calls[0]?.[0] as string;
      expect(writePath).toMatch(/\/doc_63_\d+_file$/);

      const content = onMessage.mock.calls[0]?.[1]?.content as string;
      expect(content).toMatch(
        /\[Document: \/workspace\/data\/telegram\/files\/doc_63_\d+_file\]$/,
      );
    });

    it('does not download for unregistered groups', async () => {
      const { handler, onMessage } = await getDocHandler({});

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 64,
          document: { file_id: 'doc_id', file_name: 'secret.pdf' },
        },
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('handles fetch exception gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      const { handler, onMessage } = await getDocHandler();

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 65,
          document: { file_id: 'doc_id', file_name: 'data.csv' },
        },
      });

      expect(onMessage).toHaveBeenCalledWith(
        'tg:999',
        expect.objectContaining({
          content: '[Document: data.csv - download failed]',
        }),
      );
    });

    it('includes caption with downloaded document', async () => {
      mockSuccessfulDownload();
      const { handler, onMessage } = await getDocHandler();

      await handler({
        chat: { id: 999, type: 'group', title: 'Test' },
        from: { id: 42, first_name: 'Alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 66,
          caption: 'Here is the report',
          document: { file_id: 'doc_id', file_name: 'report.pdf' },
        },
      });

      const content = onMessage.mock.calls[0]?.[1]?.content as string;
      expect(content).toMatch(
        /^\[Document: \/workspace\/data\/telegram\/files\//,
      );
      expect(content).toContain('Here is the report');
    });
  });

  describe('registerChannel side effect', () => {
    it('registers telegram factory via registerChannel', async () => {
      // registerChannelSpy is the mock backing ./registry.js's registerChannel.
      // The import of telegram.ts (at module load) triggers registerChannel('telegram', ...).
      // Because vi.clearAllMocks() clears call history, we re-import to retrigger.
      vi.resetModules();
      // Re-apply mocks that resetModules cleared
      await import('./telegram.js');
      expect(registerChannelSpy).toHaveBeenCalledWith(
        'telegram',
        expect.any(Function),
      );
    });
  });
});
