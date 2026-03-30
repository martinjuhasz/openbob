import { describe, it, expect } from 'vitest';

import { channelFromJid } from './config.js';

describe('channelFromJid', () => {
  it('maps tg: prefix to telegram', () => {
    expect(channelFromJid('tg:-1001234567890')).toBe('telegram');
  });

  it('maps mm: prefix to mattermost', () => {
    expect(channelFromJid('mm:bsn8i7mwgbgej8cq3ppda7r98w')).toBe('mattermost');
  });

  it('returns unknown for unrecognised prefix', () => {
    expect(channelFromJid('slack:C123')).toBe('unknown');
  });

  it('returns unknown when no colon present', () => {
    expect(channelFromJid('nocolon')).toBe('unknown');
  });

  it('returns unknown for empty string', () => {
    expect(channelFromJid('')).toBe('unknown');
  });

  it('handles colon-only JID', () => {
    expect(channelFromJid(':')).toBe('unknown');
  });

  it('uses only the part before the first colon', () => {
    expect(channelFromJid('tg:123:extra')).toBe('telegram');
  });
});
