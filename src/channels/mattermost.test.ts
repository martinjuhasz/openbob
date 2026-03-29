import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures the class is available when vi.mock factory runs (hoisted to top)
const { MockWebSocketClient } = vi.hoisted(() => {
  class MockWebSocketClient {
    setEventCallback = vi.fn();
    setFirstConnectCallback = vi.fn();
    setErrorCallback = vi.fn();
    setReconnectCallback = vi.fn();
    initialize = vi.fn();
    close = vi.fn();
  }
  return { MockWebSocketClient };
});

vi.mock('@mattermost/client', () => ({
  default: { WebSocketClient: MockWebSocketClient },
  WebSocketClient: MockWebSocketClient,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock registry so import of mattermost.ts doesn't fail on side effect
vi.mock('./registry.js', () => ({
  registerChannel: vi.fn(),
}));

import { MattermostChannel } from './mattermost.js';

const baseOpts = {
  baseUrl: 'https://mm.example.com',
  token: 'test-token',
  onMessage: vi.fn(),
  onChatMetadata: vi.fn(),
};

describe('MattermostChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ownsJid', () => {
    it('claims JIDs starting with mm:', () => {
      const ch = new MattermostChannel(baseOpts);
      expect(ch.ownsJid('mm:abc123')).toBe(true);
    });

    it('rejects JIDs from other channels', () => {
      const ch = new MattermostChannel(baseOpts);
      expect(ch.ownsJid('tg:-1001234567890')).toBe(false);
      expect(ch.ownsJid('dc:1234')).toBe(false);
      expect(ch.ownsJid('anything-else')).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('returns false before connect()', () => {
      const ch = new MattermostChannel(baseOpts);
      expect(ch.isConnected()).toBe(false);
    });
  });

  describe('name', () => {
    it('is "mattermost"', () => {
      const ch = new MattermostChannel(baseOpts);
      expect(ch.name).toBe('mattermost');
    });
  });

  describe('sendMessage', () => {
    it('calls POST /api/v4/posts with correct channel_id and message', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'post123' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const ch = new MattermostChannel(baseOpts);
      await ch.sendMessage('mm:channel-abc', 'Hello World');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://mm.example.com/api/v4/posts');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body as string) as {
        channel_id: string;
        message: string;
      };
      expect(body.channel_id).toBe('channel-abc');
      expect(body.message).toBe('Hello World');

      vi.unstubAllGlobals();
    });

    it('injects Bearer token in Authorization header', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'post123' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const ch = new MattermostChannel({ ...baseOpts, token: 'mytoken' });
      await ch.sendMessage('mm:ch1', 'hi');

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer mytoken');

      vi.unstubAllGlobals();
    });
  });

  describe('JID format', () => {
    it('strips mm: prefix to get channel ID for sendMessage', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const ch = new MattermostChannel(baseOpts);
      await ch.sendMessage('mm:my-channel-id-456', 'test');

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { channel_id: string };
      expect(body.channel_id).toBe('my-channel-id-456');

      vi.unstubAllGlobals();
    });
  });
});
