import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock matrix-js-sdk
const mockClient = vi.hoisted(() => ({
  on: vi.fn(),
  startClient: vi.fn().mockResolvedValue(undefined),
  stopClient: vi.fn(),
  sendHtmlMessage: vi.fn().mockResolvedValue({}),
  sendNotice: vi.fn().mockResolvedValue({}),
  sendMessage: vi.fn().mockResolvedValue({}),
  sendTyping: vi.fn().mockResolvedValue({}),
  getUserId: vi.fn().mockReturnValue('@bot:example.com'),
  uploadContent: vi.fn().mockResolvedValue({ content_uri: 'mxc://test/123' }),
  mxcUrlToHttp: vi
    .fn()
    .mockReturnValue('https://matrix.example.com/_matrix/media/...'),
  joinRoom: vi.fn().mockResolvedValue({}),
}));

vi.mock('matrix-js-sdk', () => ({
  createClient: vi.fn(() => mockClient),
  ClientEvent: { Sync: 'sync' },
  RoomEvent: { Timeline: 'Room.timeline', MyMembership: 'Room.myMembership' },
  SyncState: { Prepared: 'PREPARED', Error: 'ERROR' },
  EventType: { RoomMessage: 'm.room.message' },
  MsgType: {
    Text: 'm.text',
    Notice: 'm.notice',
    Image: 'm.image',
    File: 'm.file',
    Video: 'm.video',
    Audio: 'm.audio',
  },
  KnownMembership: { Invite: 'invite' },
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock registry so import of matrix.ts doesn't fail on side effect
vi.mock('./registry.js', () => ({
  registerChannel: vi.fn(),
}));

import { MatrixChannel } from './matrix.js';

const baseOpts = {
  homeserverUrl: 'https://matrix.example.com',
  accessToken: 'test-token',
  botUserId: '@bot:example.com',
  onMessage: vi.fn(),
  onChatMetadata: vi.fn(),
  registeredGroups: vi.fn(() => ({})),
};

/**
 * Helper to simulate a connected MatrixChannel.
 * connect() calls createClient (→ mockClient), registers event handlers, then
 * calls startClient. We make startClient immediately fire the Sync.Prepared
 * callback so connect() resolves.
 */
async function connectChannel(ch: MatrixChannel): Promise<void> {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  mockClient.on.mockImplementation(
    (event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
  );

  mockClient.startClient.mockImplementation(async () => {
    // Fire sync prepared event
    const syncHandlers = handlers.get('sync') ?? [];
    for (const h of syncHandlers) {
      h('PREPARED');
    }
  });

  await ch.connect();
}

describe('MatrixChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ownsJid', () => {
    it('claims JIDs starting with mx:', () => {
      const ch = new MatrixChannel(baseOpts);
      expect(ch.ownsJid('mx:!abc123:matrix.org')).toBe(true);
    });

    it('rejects JIDs from other channels', () => {
      const ch = new MatrixChannel(baseOpts);
      expect(ch.ownsJid('tg:-1001234567890')).toBe(false);
      expect(ch.ownsJid('dc:1234')).toBe(false);
      expect(ch.ownsJid('anything-else')).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('returns false before connect()', () => {
      const ch = new MatrixChannel(baseOpts);
      expect(ch.isConnected()).toBe(false);
    });

    it('returns true after connect()', async () => {
      const ch = new MatrixChannel(baseOpts);
      await connectChannel(ch);
      expect(ch.isConnected()).toBe(true);
    });
  });

  describe('name', () => {
    it('is "matrix"', () => {
      const ch = new MatrixChannel(baseOpts);
      expect(ch.name).toBe('matrix');
    });
  });

  describe('sendMessage', () => {
    it('calls sendHtmlMessage with correct roomId and text', async () => {
      const ch = new MatrixChannel(baseOpts);
      await connectChannel(ch);

      await ch.sendMessage('mx:!room123:example.com', 'Hello World');

      expect(mockClient.sendHtmlMessage).toHaveBeenCalledOnce();
      const [roomId, text] = mockClient.sendHtmlMessage.mock.calls[0] as [
        string,
        string,
        string,
      ];
      expect(roomId).toBe('!room123:example.com');
      expect(text).toBe('Hello World');
    });
  });

  describe('JID format', () => {
    it('strips mx: prefix to get room ID for sendMessage', async () => {
      const ch = new MatrixChannel(baseOpts);
      await connectChannel(ch);

      await ch.sendMessage('mx:!my-room-id:matrix.org', 'test');

      const [roomId] = mockClient.sendHtmlMessage.mock.calls[0] as [string];
      expect(roomId).toBe('!my-room-id:matrix.org');
    });
  });

  describe('disconnect', () => {
    it('marks as disconnected', async () => {
      const ch = new MatrixChannel(baseOpts);
      await connectChannel(ch);
      expect(ch.isConnected()).toBe(true);

      await ch.disconnect();
      expect(ch.isConnected()).toBe(false);
      expect(mockClient.stopClient).toHaveBeenCalledOnce();
    });
  });

  describe('sendTyping', () => {
    it('calls sendTyping with correct roomId', async () => {
      const ch = new MatrixChannel(baseOpts);
      await connectChannel(ch);

      await ch.sendTyping('mx:!room123:example.com');

      expect(mockClient.sendTyping).toHaveBeenCalledWith(
        '!room123:example.com',
        true,
        15_000,
      );
    });
  });
});
