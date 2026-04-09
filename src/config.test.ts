import { describe, it, expect } from 'vitest';

import { channelFromJid, isValidGroupFolder } from './config.js';

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

describe('isValidGroupFolder', () => {
  it('accepts simple lowercase slugs', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('my-group')).toBe(true);
    expect(isValidGroupFolder('group123')).toBe(true);
    expect(isValidGroupFolder('a')).toBe(true);
  });

  it('accepts dots and underscores', () => {
    expect(isValidGroupFolder('my.group')).toBe(true);
    expect(isValidGroupFolder('my_group')).toBe(true);
  });

  it('accepts names starting with a digit', () => {
    expect(isValidGroupFolder('1group')).toBe(true);
    expect(isValidGroupFolder('0')).toBe(true);
  });

  it('rejects path traversal', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('../secrets')).toBe(false);
  });

  it('rejects names with slashes', () => {
    expect(isValidGroupFolder('a/b')).toBe(false);
    expect(isValidGroupFolder('/absolute')).toBe(false);
  });

  it('rejects uppercase characters', () => {
    expect(isValidGroupFolder('MyGroup')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('rejects names starting with a dot or hyphen', () => {
    expect(isValidGroupFolder('.hidden')).toBe(false);
    expect(isValidGroupFolder('-invalid')).toBe(false);
  });

  it('rejects names longer than 64 characters', () => {
    expect(isValidGroupFolder('a'.repeat(65))).toBe(false);
    expect(isValidGroupFolder('a'.repeat(64))).toBe(true);
  });

  it('rejects spaces and special characters', () => {
    expect(isValidGroupFolder('my group')).toBe(false);
    expect(isValidGroupFolder('my@group')).toBe(false);
    expect(isValidGroupFolder('my$group')).toBe(false);
  });
});
