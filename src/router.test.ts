import { describe, it, expect } from 'vitest';
import {
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

describe('formatMessages', () => {
  it('formats messages as [sender](timestamp): content', () => {
    const result = formatMessages([makeMessage('hello')]);
    expect(result).toBe('[Alice](2026-01-01T00:00:00.000Z): hello');
  });

  it('joins multiple messages with newlines', () => {
    const result = formatMessages([
      makeMessage('hello', 'Alice'),
      makeMessage('world', 'Bob'),
    ]);
    expect(result).toBe(
      '[Alice](2026-01-01T00:00:00.000Z): hello\n[Bob](2026-01-01T00:00:00.000Z): world',
    );
  });

  it('preserves special characters in content', () => {
    const result = formatMessages([makeMessage('<script> & "quotes"')]);
    expect(result).toContain('<script> & "quotes"');
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

  it('removes malformed tags with missing < (DeepSeek variant)', () => {
    expect(
      stripInternalTags(
        'internal>Lese die Kontextdatei, um meine Identität zu verinternal>\n\nhallo',
      ),
    ).toBe('hallo');
  });

  it('removes <think> blocks (DeepSeek reasoning)', () => {
    expect(stripInternalTags('hello <think>reasoning here</think> world')).toBe(
      'hello  world',
    );
  });

  it('removes multiline <think> blocks', () => {
    expect(
      stripInternalTags('hi\n<think>\nstep 1\nstep 2\n</think>\nresult'),
    ).toBe('hi\n\nresult');
  });

  it('removes mixed <think> and <internal> blocks', () => {
    expect(
      stripInternalTags(
        '<think>planning</think>\n<internal>notes</internal>\nanswer',
      ),
    ).toBe('answer');
  });

  it('handles case-insensitive tags', () => {
    expect(stripInternalTags('a <Internal>b</Internal> c')).toBe('a  c');
    expect(stripInternalTags('a <THINK>b</THINK> c')).toBe('a  c');
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
    expect(checkTrigger([makeMessage('@openbob hello')], 'openbob')).toBe(true);
  });

  it('detects trigger without @', () => {
    expect(
      checkTrigger([makeMessage('openbob please do this')], 'openbob'),
    ).toBe(true);
  });

  it('returns false when no trigger', () => {
    expect(checkTrigger([makeMessage('hello there')], 'openbob')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(checkTrigger([makeMessage('@OpenBob hi')], 'openbob')).toBe(true);
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
