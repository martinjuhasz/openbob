import { describe, it, expect } from 'vitest';

// We test registry logic directly — import after resetting module state
// Since registry uses a module-level Map, we create a local test version

import {
  registerChannel,
  getChannelFactory,
  getRegisteredChannelNames,
} from './registry.js';

// NOTE: the registry Map persists across tests since it's module-level.
// We just verify the API contract — actual cleanup isn't needed for these tests.

describe('channel registry', () => {
  it('registers and retrieves a channel factory', () => {
    const factory = () => null;
    registerChannel('test-channel-1', factory);
    expect(getChannelFactory('test-channel-1')).toBe(factory);
  });

  it('returns undefined for unknown channel', () => {
    expect(getChannelFactory('nonexistent-xyz')).toBeUndefined();
  });

  it('includes registered channels in getRegisteredChannelNames', () => {
    registerChannel('test-channel-2', () => null);
    const names = getRegisteredChannelNames();
    expect(names).toContain('test-channel-2');
  });

  it('overwrites a factory when registering with same name', () => {
    const factory1 = () => null;
    const factory2 = () => null;
    registerChannel('test-channel-overwrite', factory1);
    registerChannel('test-channel-overwrite', factory2);
    expect(getChannelFactory('test-channel-overwrite')).toBe(factory2);
  });
});
