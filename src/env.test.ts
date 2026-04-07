import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('loadEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('exits when MATTERMOST_URL is missing', async () => {
    process.env = { MATTERMOST_TOKEN: 'token123' };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });
    const { loadEnv } = await import('./env.js');
    expect(() => loadEnv()).toThrow('process.exit called');
    exitSpy.mockRestore();
  });

  it('exits when MATTERMOST_TOKEN is missing', async () => {
    process.env = { MATTERMOST_URL: 'https://mm.example.com' };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });
    const { loadEnv } = await import('./env.js');
    expect(() => loadEnv()).toThrow('process.exit called');
    exitSpy.mockRestore();
  });

  it('exits when MODEL is missing', async () => {
    process.env = {
      MATTERMOST_URL: 'https://mm.example.com',
      MATTERMOST_TOKEN: 'token123',
    };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });
    const { loadEnv } = await import('./env.js');
    expect(() => loadEnv()).toThrow('process.exit called');
    exitSpy.mockRestore();
  });

  it('accepts valid minimal config', async () => {
    process.env = {
      MATTERMOST_URL: 'https://mm.example.com',
      MATTERMOST_TOKEN: 'token123',
      MODEL: 'anthropic/claude-sonnet-4-6',
    };
    const { loadEnv } = await import('./env.js');
    const env = loadEnv();
    expect(env.MATTERMOST_URL).toBe('https://mm.example.com');
    expect(env.MATTERMOST_TOKEN).toBe('token123');
    expect(env.MODEL).toBe('anthropic/claude-sonnet-4-6');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('respects custom MODEL', async () => {
    process.env = {
      MATTERMOST_URL: 'https://mm.example.com',
      MATTERMOST_TOKEN: 'token123',
      MODEL: 'openrouter/anthropic/claude-opus-4',
    };
    const { loadEnv } = await import('./env.js');
    const env = loadEnv();
    expect(env.MODEL).toBe('openrouter/anthropic/claude-opus-4');
  });

  it('defaults OPENVIKING_SCOPE to global', async () => {
    process.env = {
      MODEL: 'anthropic/claude-sonnet-4-6',
    };
    const { loadEnv } = await import('./env.js');
    const env = loadEnv();
    expect(env.OPENVIKING_SCOPE).toBe('global');
  });

  it('accepts OPENVIKING_SCOPE=group', async () => {
    process.env = {
      MODEL: 'anthropic/claude-sonnet-4-6',
      OPENVIKING_SCOPE: 'group',
    };
    const { loadEnv } = await import('./env.js');
    const env = loadEnv();
    expect(env.OPENVIKING_SCOPE).toBe('group');
  });

  it('rejects invalid OPENVIKING_SCOPE', async () => {
    process.env = {
      MODEL: 'anthropic/claude-sonnet-4-6',
      OPENVIKING_SCOPE: 'invalid',
    };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });
    const { loadEnv } = await import('./env.js');
    expect(() => loadEnv()).toThrow('process.exit called');
    exitSpy.mockRestore();
  });

  it('accepts OPENVIKING_API_KEY', async () => {
    process.env = {
      MODEL: 'anthropic/claude-sonnet-4-6',
      OPENVIKING_API_KEY: 'my-root-key',
    };
    const { loadEnv } = await import('./env.js');
    const env = loadEnv();
    expect(env.OPENVIKING_API_KEY).toBe('my-root-key');
  });

  it('leaves OPENVIKING_API_KEY undefined when not set', async () => {
    process.env = {
      MODEL: 'anthropic/claude-sonnet-4-6',
    };
    const { loadEnv } = await import('./env.js');
    const env = loadEnv();
    expect(env.OPENVIKING_API_KEY).toBeUndefined();
  });
});
