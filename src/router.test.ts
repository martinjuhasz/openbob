import { describe, it, expect } from 'vitest';
import {
  escapeXml,
  formatMessages,
  stripInternalTags,
  formatOutbound,
  checkTrigger,
  findChannel,
  routeOutbound,
} from './router.js';
import { Channel, NewMessage } from './types.js';

function makeMessage(content: string, sender_name = 'Alice'): NewMessage {
  return {
    id: '1',
    chat_jid: 'mm:abc',
    sender: 'alice',
    sender_name,
    content,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

function makeChannel(
  name: string,
  jidPrefix: string,
  connected = true,
): Channel {
  return {
    name,
    ownsJid: (jid) => jid.startsWith(jidPrefix),
    isConnected: () => connected,
    connect: async () => {},
    disconnect: async () => {},
    sendMessage: async () => {},
  };
}

describe('escapeXml', () => {
  it('escapes special chars', () => {
    expect(escapeXml('<hello & "world">')).toBe(
      '&lt;hello &amp; &quot;world&quot;&gt;',
    );
  });

  it('returns empty string for falsy input', () => {
    expect(escapeXml('')).toBe('');
  });
});

describe('formatMessages', () => {
  it('wraps messages in XML', () => {
    const result = formatMessages([makeMessage('hello')]);
    expect(result).toContain('<messages>');
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('hello');
  });

  it('escapes message content', () => {
    const result = formatMessages([makeMessage('<script>')]);
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>');
  });
});

describe('stripInternalTags', () => {
  it('removes internal blocks', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('removes multiline internal blocks', () => {
    expect(stripInternalTags('hi\n<internal>\nreason\n</internal>\nbye')).toBe(
      'hi\n\nbye',
    );
  });

  it('returns unchanged when no internal tags', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
  });
});

describe('formatOutbound', () => {
  it('strips internal tags and returns text', () => {
    expect(formatOutbound('hello <internal>x</internal> world')).toBe(
      'hello  world',
    );
  });

  it('returns empty string for all-internal content', () => {
    expect(formatOutbound('<internal>hidden</internal>')).toBe('');
  });
});

describe('checkTrigger', () => {
  it('detects trigger word', () => {
    expect(checkTrigger([makeMessage('@yetaclaw hello')], 'yetaclaw')).toBe(
      true,
    );
  });

  it('detects trigger without @', () => {
    expect(
      checkTrigger([makeMessage('yetaclaw please do this')], 'yetaclaw'),
    ).toBe(true);
  });

  it('returns false when no trigger', () => {
    expect(checkTrigger([makeMessage('hello there')], 'yetaclaw')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(checkTrigger([makeMessage('@YetaClaw hi')], 'yetaclaw')).toBe(true);
  });
});

describe('findChannel', () => {
  it('finds channel by JID prefix', () => {
    const ch = makeChannel('mm', 'mm:');
    expect(findChannel([ch], 'mm:abc')).toBe(ch);
  });

  it('returns undefined when no match', () => {
    const ch = makeChannel('mm', 'mm:');
    expect(findChannel([ch], 'tg:abc')).toBeUndefined();
  });
});

describe('routeOutbound', () => {
  it('sends to correct channel', async () => {
    const sent: string[] = [];
    const ch: Channel = {
      ...makeChannel('mm', 'mm:'),
      sendMessage: async (_jid, text) => {
        sent.push(text);
      },
    };
    await routeOutbound([ch], 'mm:abc', 'hello');
    expect(sent).toEqual(['hello']);
  });

  it('throws when no channel found', () => {
    const ch = makeChannel('mm', 'mm:');
    expect(() => routeOutbound([ch], 'tg:abc', 'hi')).toThrow(
      'No channel for JID',
    );
  });

  it('throws when channel disconnected', () => {
    const ch = makeChannel('mm', 'mm:', false);
    expect(() => routeOutbound([ch], 'mm:abc', 'hi')).toThrow(
      'No channel for JID',
    );
  });
});
