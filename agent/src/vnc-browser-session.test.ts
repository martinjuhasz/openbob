import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process to prevent real process spawning
const mockProc = {
  stdout: { resume: vi.fn() },
  stderr: { resume: vi.fn() },
  kill: vi.fn(),
  pid: 1234,
};

vi.mock('child_process', () => ({
  execFile: vi.fn(() => mockProc),
}));

vi.mock('util', () => ({
  promisify: vi.fn(() => async () => ({ stdout: '', stderr: '' })),
}));

vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => {
      throw new Error('ENOENT');
    }),
  },
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => {
    throw new Error('ENOENT');
  }),
}));

describe('vnc-browser-session – validation', () => {
  let mod: Awaited<typeof import('./vnc-browser-session.js')>;

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('./vnc-browser-session.js');
  });

  it('rejects invalid session names with uppercase', async () => {
    await expect(mod.startVncBrowserSession('INVALID')).rejects.toThrow(
      'Invalid session name',
    );
  });

  it('rejects names with spaces', async () => {
    await expect(mod.startVncBrowserSession('has space')).rejects.toThrow(
      'Invalid session name',
    );
  });

  it('rejects names starting with dot', async () => {
    await expect(mod.startVncBrowserSession('.hidden')).rejects.toThrow(
      'Invalid session name',
    );
  });

  it('rejects names starting with hyphen', async () => {
    await expect(mod.startVncBrowserSession('-bad')).rejects.toThrow(
      'Invalid session name',
    );
  });

  it('accepts valid lowercase name', async () => {
    const result = await mod.startVncBrowserSession('my-site.de');
    expect(result.port).toBe(6080);
    expect(result.url).toContain('vnc.html');
  });

  it('uses VNC_HOST_ADDRESS and VNC_EXTERNAL_PORT from env', async () => {
    process.env['VNC_HOST_ADDRESS'] = '10.0.0.5';
    process.env['VNC_EXTERNAL_PORT'] = '7042';

    const result = await mod.startVncBrowserSession('envtest');
    expect(result.url).toBe('http://10.0.0.5:7042/vnc.html?autoconnect=true');

    delete process.env['VNC_HOST_ADDRESS'];
    delete process.env['VNC_EXTERNAL_PORT'];
  });

  it('defaults to localhost:6080 when no env vars set', async () => {
    delete process.env['VNC_HOST_ADDRESS'];
    delete process.env['VNC_EXTERNAL_PORT'];

    const result = await mod.startVncBrowserSession('defaults');
    expect(result.url).toBe('http://localhost:6080/vnc.html?autoconnect=true');
  });
});

describe('vnc-browser-session – session state', () => {
  let mod: Awaited<typeof import('./vnc-browser-session.js')>;

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('./vnc-browser-session.js');
  });

  it('initially has no active session', () => {
    expect(mod.isVncSessionActive()).toBe(false);
    expect(mod.getActiveVncSessionName()).toBeNull();
  });

  it('marks session as active after start', async () => {
    await mod.startVncBrowserSession('test1');
    expect(mod.isVncSessionActive()).toBe(true);
    expect(mod.getActiveVncSessionName()).toBe('test1');
  });

  it('rejects second concurrent session', async () => {
    await mod.startVncBrowserSession('first');
    await expect(mod.startVncBrowserSession('second')).rejects.toThrow(
      'already active: "first"',
    );
  });

  it('stopVncBrowserSession throws when no session active', async () => {
    await expect(mod.stopVncBrowserSession('none')).rejects.toThrow(
      'No active VNC browser session',
    );
  });

  it('stopVncBrowserSession throws on name mismatch', async () => {
    await mod.startVncBrowserSession('running');
    await expect(mod.stopVncBrowserSession('other')).rejects.toThrow(
      'Active VNC session is "running", not "other"',
    );
  });

  it('stopVncBrowserSession clears active session', async () => {
    await mod.startVncBrowserSession('tostop');
    await mod.stopVncBrowserSession('tostop');
    expect(mod.isVncSessionActive()).toBe(false);
    expect(mod.getActiveVncSessionName()).toBeNull();
  }, 15_000);

  it('isProfileLockedByVnc returns true for active profile', async () => {
    await mod.startVncBrowserSession('locked');
    expect(mod.isProfileLockedByVnc('locked')).toBe(true);
    expect(mod.isProfileLockedByVnc('other')).toBe(false);
  });

  it('isProfileLockedByVnc returns false when no session active', () => {
    expect(mod.isProfileLockedByVnc('anything')).toBe(false);
  });
});

describe('vnc-browser-session – listBrowserProfiles', () => {
  it('returns empty array on ENOENT', async () => {
    vi.resetModules();
    const mod = await import('./vnc-browser-session.js');
    expect(mod.listBrowserProfiles()).toEqual([]);
  });
});
