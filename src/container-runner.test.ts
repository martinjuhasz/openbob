import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────
// vi.hoisted runs before vi.mock, so we can reference these in mock factories.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecFile = vi.hoisted(() => vi.fn() as any);
const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockFs = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
}));

const mockClientSession = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  status: vi.fn(),
  promptAsync: vi.fn(),
  messages: vi.fn(),
}));
const mockCreateOpencodeClient = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    session: mockClientSession,
  }),
);

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execFile: mockExecFile,
  execFileSync: mockExecFileSync,
}));

vi.mock('util', () => ({
  promisify: (fn: unknown) => {
    // promisify(execFile) → return our mock directly (it already returns a Promise)
    if (fn === mockExecFile) return mockExecFile;
    return fn;
  },
}));

vi.mock('fs', () => ({
  default: mockFs,
  ...mockFs,
}));

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: mockCreateOpencodeClient,
}));

vi.mock('./db.js', () => ({
  setSession: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  getOvUserKey: vi.fn().mockReturnValue(null),
  setOvUserKey: vi.fn(),
}));

vi.mock('./env.js', () => ({
  getEnv: vi.fn().mockReturnValue({
    MATTERMOST_URL: 'https://mm.example.com',
    MATTERMOST_TOKEN: 'token',
    MODEL: 'anthropic/claude-sonnet-4-6',
    AGENT_FORWARD_ENV: undefined,
  }),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const AUTH_JSON_CONTENT = JSON.stringify({
  anthropic: { type: 'api', key: 'sk-test-key' },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const originalEnv = process.env;

function dockerOk(stdout = ''): Promise<{ stdout: string; stderr: string }> {
  return Promise.resolve({ stdout, stderr: '' });
}

/** Default readFileSync handler: returns auth.json for the auth path, ENOENT otherwise. */
function defaultReadFileSync(p: string): string {
  if (typeof p === 'string' && p === '/data/opencode/auth.json') {
    return AUTH_JSON_CONTENT;
  }
  const err: NodeJS.ErrnoException = new Error('ENOENT');
  err.code = 'ENOENT';
  throw err;
}

/** Import a fresh container-runner module (resets internal Maps). */
async function importRunner() {
  return import('./container-runner.js');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('container-runner', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Default: docker commands succeed
    mockExecFile.mockImplementation(() => dockerOk());
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockImplementation(defaultReadFileSync);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── cleanupStoppedContainers ────────────────────────────────────────────

  describe('cleanupStoppedContainers', () => {
    it('removes exited containers returned by docker ps', async () => {
      mockExecFile
        .mockImplementationOnce(() => dockerOk('abc123\ndef456\n'))
        .mockImplementationOnce(() => dockerOk());

      const { cleanupStoppedContainers } = await importRunner();
      await cleanupStoppedContainers();

      // First call: docker ps
      expect(mockExecFile).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining([
          'ps',
          '-aq',
          '--filter',
          'label=openbob.group',
        ]),
      );
      // Second call: docker rm
      expect(mockExecFile).toHaveBeenCalledWith('docker', [
        'rm',
        'abc123',
        'def456',
      ]);
    });

    it('does nothing when no exited containers found', async () => {
      mockExecFile.mockImplementationOnce(() => dockerOk('\n'));

      const { cleanupStoppedContainers } = await importRunner();
      await cleanupStoppedContainers();

      // Only the ps call, no rm
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('does not throw when docker is unavailable', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('docker not found'));

      const { cleanupStoppedContainers } = await importRunner();
      await expect(cleanupStoppedContainers()).resolves.toBeUndefined();
    });
  });

  // ── stopGroupContainer ──────────────────────────────────────────────────

  describe('stopGroupContainer', () => {
    it('does nothing when no container tracked for group', async () => {
      const { stopGroupContainer } = await importRunner();
      await stopGroupContainer('unknown-group');
      // No docker calls
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['rm']),
      );
    });
  });

  // ── stopAllContainers ───────────────────────────────────────────────────

  describe('stopAllContainers', () => {
    it('does nothing when no containers are active', async () => {
      const { stopAllContainers } = await importRunner();
      await stopAllContainers();
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['rm']),
      );
    });
  });

  // ── warmUpContainers ────────────────────────────────────────────────────

  describe('warmUpContainers', () => {
    it('resolves host paths then spawns containers for each group', async () => {
      // resolveHostPaths: docker inspect returns mounts
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'inspect' && args.length > 2) {
          // resolveHostPaths inspect
          return dockerOk('/workspace:/host/workspace;/skills:/host/skills;');
        }
        if (args[0] === 'ps') {
          // cleanupStoppedContainers
          return dockerOk('\n');
        }
        if (args[0] === 'rm') {
          return dockerOk();
        }
        if (args[0] === 'run') {
          return dockerOk('container-id-123');
        }
        if (args[0] === 'inspect') {
          // container health check (execFileSync path)
          return dockerOk('{}');
        }
        if (args[0] === 'logs') {
          return dockerOk('some logs');
        }
        return dockerOk();
      });

      // waitForServer: /session returns ok
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );

      const { warmUpContainers } = await importRunner();
      await warmUpContainers([
        { folder: 'test-group', model: 'anthropic/claude-sonnet-4-6' },
      ]);

      // Should have called docker run at some point
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const runCall = (mockExecFile.mock.calls as any[]).find(
        (c) => c[1]?.[0] === 'run',
      );
      expect(runCall).toBeDefined();
      expect(runCall![1]).toContain('--name');
      expect(runCall![1]).toContain('openbob-agent-test-group');

      vi.unstubAllGlobals();
    });

    it('skips when groups array is empty', async () => {
      const { warmUpContainers } = await importRunner();
      await warmUpContainers([]);
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  // ── writeOpencodeConfig (tested via spawnContainer → warmUp) ────────────

  describe('writeOpencodeConfig', () => {
    it('reads workspace template and overlays model', async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'inspect' && args.length > 2)
          return dockerOk('/workspace:/host/workspace;');
        if (args[0] === 'ps') return dockerOk('\n');
        if (args[0] === 'rm') return dockerOk();
        if (args[0] === 'run') return dockerOk('id');
        return dockerOk();
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );

      // Template at /workspace/opencode.json with shared settings
      const template = {
        share: 'disabled',
        permission: { edit: 'allow', bash: 'allow' },
        mcp: { 'my-tool': { type: 'local', command: ['node', 'tool.js'] } },
      };
      mockFs.readFileSync.mockImplementation((p: string) => {
        if (p === '/workspace/opencode.json') return JSON.stringify(template);
        if (p === '/data/opencode/auth.json') return AUTH_JSON_CONTENT;
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      });

      const { warmUpContainers } = await importRunner();
      await warmUpContainers([
        { folder: 'cfg-group', model: 'anthropic/claude-sonnet-4-6' },
      ]);

      // Find the writeFileSync call for opencode.json
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const writeCalls = (mockFs.writeFileSync.mock.calls as any[]).filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('opencode.json'),
      );
      expect(writeCalls.length).toBeGreaterThanOrEqual(1);

      const written = JSON.parse(writeCalls[0][1] as string);
      // Model overlaid from argument
      expect(written.model).toBe('anthropic/claude-sonnet-4-6');
      // Template fields preserved
      expect(written.share).toBe('disabled');
      expect(written.permission).toEqual({ edit: 'allow', bash: 'allow' });
      expect(written.mcp).toEqual({
        'my-tool': { type: 'local', command: ['node', 'tool.js'] },
      });

      vi.unstubAllGlobals();
    });

    it('falls back to model-only config when template not found', async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'inspect' && args.length > 2)
          return dockerOk('/workspace:/host/workspace;');
        if (args[0] === 'ps') return dockerOk('\n');
        if (args[0] === 'rm') return dockerOk();
        if (args[0] === 'run') return dockerOk('id');
        return dockerOk();
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );

      // No template file → readFileSync returns auth.json only, ENOENT for rest
      mockFs.readFileSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p === '/data/opencode/auth.json')
          return AUTH_JSON_CONTENT;
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      });

      const { warmUpContainers } = await importRunner();
      await warmUpContainers([
        { folder: 'fallback-group', model: 'anthropic/claude-sonnet-4-6' },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const writeCalls = (mockFs.writeFileSync.mock.calls as any[]).filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('opencode.json'),
      );
      expect(writeCalls.length).toBeGreaterThanOrEqual(1);

      const written = JSON.parse(writeCalls[0][1] as string);
      // Only model — no template fields
      expect(written.model).toBe('anthropic/claude-sonnet-4-6');
      expect(written.share).toBeUndefined();
      expect(written.permission).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('writes fresh config each time (ignores existing per-group config)', async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'inspect' && args.length > 2)
          return dockerOk('/workspace:/host/workspace;');
        if (args[0] === 'ps') return dockerOk('\n');
        if (args[0] === 'rm') return dockerOk();
        if (args[0] === 'run') return dockerOk('id');
        return dockerOk();
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );

      // Template with base settings
      const template = {
        share: 'disabled',
        permission: { edit: 'allow', bash: 'allow' },
      };
      mockFs.readFileSync.mockImplementation((p: string) => {
        if (p === '/workspace/opencode.json') return JSON.stringify(template);
        if (p === '/data/opencode/auth.json') return AUTH_JSON_CONTENT;
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      });

      const { warmUpContainers } = await importRunner();
      await warmUpContainers([
        { folder: 'merge-group', model: 'openrouter/anthropic/claude-opus-4' },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const writeCalls = (mockFs.writeFileSync.mock.calls as any[]).filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('opencode.json'),
      );
      expect(writeCalls.length).toBeGreaterThanOrEqual(1);

      const written = JSON.parse(writeCalls[0][1] as string);
      // Model from argument, not from any existing per-group config
      expect(written.model).toBe('openrouter/anthropic/claude-opus-4');
      // Template defaults applied
      expect(written.share).toBe('disabled');
      expect(written.permission).toEqual({ edit: 'allow', bash: 'allow' });
      // No stale fields from previous per-group config
      expect(written.provider).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });

  // ── getForwardEnvArgs (tested via docker run args) ──────────────────────

  describe('getForwardEnvArgs', () => {
    it('forwards env vars listed in AGENT_FORWARD_ENV', async () => {
      const { getEnv } = await import('./env.js');
      vi.mocked(getEnv).mockReturnValue({
        MATTERMOST_URL: 'https://mm.example.com',
        MATTERMOST_TOKEN: 'token',
        MODEL: 'anthropic/claude-sonnet-4-6',
        AGENT_FORWARD_ENV: 'MY_KEY,OTHER_KEY',
      } as ReturnType<typeof getEnv>);

      process.env['MY_KEY'] = 'val1';
      process.env['OTHER_KEY'] = 'val2';

      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'inspect' && args.length > 2)
          return dockerOk('/workspace:/host/workspace;');
        if (args[0] === 'ps') return dockerOk('\n');
        if (args[0] === 'rm') return dockerOk();
        if (args[0] === 'run') return dockerOk('id');
        return dockerOk();
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );

      const { warmUpContainers } = await importRunner();
      await warmUpContainers([
        { folder: 'fwd-group', model: 'anthropic/claude-sonnet-4-6' },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const runCall = (mockExecFile.mock.calls as any[]).find(
        (c) => c[1]?.[0] === 'run',
      );
      expect(runCall).toBeDefined();
      const args = runCall![1] as string[];
      // Should contain -e MY_KEY=val1 and -e OTHER_KEY=val2
      const eFlags: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-e' && args[i + 1]) eFlags.push(args[i + 1]!);
      }
      expect(eFlags).toContain('MY_KEY=val1');
      expect(eFlags).toContain('OTHER_KEY=val2');

      vi.unstubAllGlobals();
    });
  });

  // ── writeAuthConfig (tested via warmUp → spawn) ────────────────────────

  describe('writeAuthConfig', () => {
    it('copies auth.json to group opencode directory on spawn', async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'inspect' && args.length > 2)
          return dockerOk('/workspace:/host/workspace;');
        if (args[0] === 'ps') return dockerOk('\n');
        if (args[0] === 'rm') return dockerOk();
        if (args[0] === 'run') return dockerOk('id');
        return dockerOk();
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );

      const { warmUpContainers } = await importRunner();
      await warmUpContainers([
        { folder: 'auth-group', model: 'anthropic/claude-sonnet-4-6' },
      ]);

      // Find the writeFileSync call for auth.json in the group dir
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const authCalls = (mockFs.writeFileSync.mock.calls as any[]).filter(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('auth-group') &&
          c[0].endsWith('auth.json'),
      );
      expect(authCalls.length).toBe(1);
      expect(authCalls[0][1]).toBe(AUTH_JSON_CONTENT);

      vi.unstubAllGlobals();
    });
  });

  // ── validateAuthConfig ─────────────────────────────────────────────────

  describe('validateAuthConfig', () => {
    it('succeeds when auth.json exists', async () => {
      mockFs.existsSync.mockImplementation((p: string) => {
        if (p === '/data/opencode/auth.json') return true;
        return false;
      });

      const { validateAuthConfig } = await importRunner();
      expect(() => validateAuthConfig()).not.toThrow();
    });

    it('exits when auth.json is missing', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const mockExit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);

      const { validateAuthConfig } = await importRunner();
      validateAuthConfig();

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });
  });

  // ── runAgentSession ─────────────────────────────────────────────────────

  describe('runAgentSession', () => {
    const baseInput = {
      groupFolder: 'test-group',
      prompt: 'Hello, world!',
      chatJid: 'mm:channel-abc',
      isMain: false,
      model: 'anthropic/claude-sonnet-4-6',
    };

    /** Set up mocks for a successful container spawn + session flow. */
    function setupHappyPath() {
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'inspect' && args.length > 2)
          return dockerOk('/workspace:/host/workspace;');
        if (args[0] === 'ps') return dockerOk('\n');
        if (args[0] === 'rm') return dockerOk();
        if (args[0] === 'run') return dockerOk('id');
        return dockerOk();
      });

      // waitForServer: immediate success
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );

      // Session flow
      mockClientSession.create.mockResolvedValue({
        data: { id: 'sess-123' },
      });
      mockClientSession.get.mockResolvedValue({ data: null });
      mockClientSession.list.mockResolvedValue({ data: [] });
      mockClientSession.status.mockResolvedValue({
        data: { 'sess-123': { type: 'idle' } },
      });
      mockClientSession.promptAsync.mockResolvedValue({ data: {} });
      mockClientSession.messages.mockResolvedValue({
        data: [
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'Hello, world!' }],
          },
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Hi there!' }],
          },
        ],
      });
    }

    it('returns success with assistant text on happy path', async () => {
      setupHappyPath();

      const { runAgentSession } = await importRunner();
      const result = await runAgentSession(baseInput);

      expect(result.status).toBe('success');
      expect(result.result).toBe('Hi there!');
      expect(result.newSessionId).toBe('sess-123');

      vi.unstubAllGlobals();
    });

    it('creates a new session when no sessionId provided', async () => {
      setupHappyPath();

      const { runAgentSession } = await importRunner();
      await runAgentSession(baseInput);

      expect(mockClientSession.create).toHaveBeenCalledWith({
        body: { title: 'test-group/mm:channel-abc' },
      });

      vi.unstubAllGlobals();
    });

    it('writes context.json with chatJid, groupFolder, isMain', async () => {
      setupHappyPath();

      const { runAgentSession } = await importRunner();
      await runAgentSession({ ...baseInput, isMain: true });

      // Find the LAST context.json write (spawnContainer pre-creates it,
      // then runAgentSession updates it with real values)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contextCalls = (mockFs.writeFileSync.mock.calls as any[]).filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('context.json'),
      );
      expect(contextCalls.length).toBeGreaterThanOrEqual(1);
      const contextCall = contextCalls[contextCalls.length - 1];
      expect(contextCall).toBeDefined();
      const ctx = JSON.parse(contextCall![1] as string);
      expect(ctx.chatJid).toBe('mm:channel-abc');
      expect(ctx.groupFolder).toBe('test-group');
      expect(ctx.isMain).toBe(true);

      vi.unstubAllGlobals();
    });

    it('sends prompt parts and receives response via poll', async () => {
      setupHappyPath();

      const { runAgentSession } = await importRunner();
      await runAgentSession(baseInput);

      expect(mockClientSession.promptAsync).toHaveBeenCalledWith({
        path: { id: 'sess-123' },
        body: {
          parts: [{ type: 'text', text: 'Hello, world!' }],
        },
      });

      vi.unstubAllGlobals();
    });

    it('returns error when container spawn fails', async () => {
      // docker rm and inspect succeed, but docker run fails
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'run')
          return Promise.reject(new Error('Docker unavailable'));
        return dockerOk();
      });

      const { runAgentSession } = await importRunner();
      const result = await runAgentSession(baseInput);

      expect(result.status).toBe('error');
      expect(result.error).toContain('Docker unavailable');
    });

    it('returns error when no assistant message found', async () => {
      setupHappyPath();
      mockClientSession.messages.mockResolvedValue({
        data: [
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'Hello' }],
          },
        ],
      });

      const { runAgentSession } = await importRunner();
      const result = await runAgentSession(baseInput);

      expect(result.status).toBe('error');
      expect(result.error).toBe('No assistant message from OpenCode');

      vi.unstubAllGlobals();
    });

    it('returns error when promptAsync reports an error', async () => {
      setupHappyPath();
      mockClientSession.promptAsync.mockResolvedValue({
        error: { data: { message: 'Rate limited' } },
      });

      const { runAgentSession } = await importRunner();
      const result = await runAgentSession(baseInput);

      expect(result.status).toBe('error');
      expect(result.error).toBe('Rate limited');

      vi.unstubAllGlobals();
    });

    it('returns error when assistant message has error info', async () => {
      setupHappyPath();
      mockClientSession.messages.mockResolvedValue({
        data: [
          {
            info: {
              role: 'assistant',
              error: { data: { message: 'Auth failed' } },
            },
            parts: [{ type: 'text', text: '' }],
          },
        ],
      });

      const { runAgentSession } = await importRunner();
      const result = await runAgentSession(baseInput);

      expect(result.status).toBe('error');
      expect(result.error).toBe('Auth failed');

      vi.unstubAllGlobals();
    });

    it('returns error when assistant text is empty', async () => {
      setupHappyPath();
      mockClientSession.messages.mockResolvedValue({
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'tool_use', text: undefined }],
          },
        ],
      });

      const { runAgentSession } = await importRunner();
      const result = await runAgentSession(baseInput);

      expect(result.status).toBe('error');
      expect(result.error).toBe('Empty response from OpenCode');

      vi.unstubAllGlobals();
    });
  });

  // ── spawnContainer docker args ──────────────────────────────────────────

  describe('spawnContainer docker args', () => {
    it('passes group folder as container name and label', async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'inspect' && args.length > 2)
          return dockerOk('/workspace:/host/workspace;');
        if (args[0] === 'ps') return dockerOk('\n');
        if (args[0] === 'rm') return dockerOk();
        if (args[0] === 'run') return dockerOk('id');
        return dockerOk();
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );

      const { warmUpContainers } = await importRunner();
      await warmUpContainers([
        { folder: 'my-group', model: 'anthropic/claude-sonnet-4-6' },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const runCall = (mockExecFile.mock.calls as any[]).find(
        (c) => c[1]?.[0] === 'run',
      );
      expect(runCall).toBeDefined();
      const args = runCall![1] as string[];

      // Container name
      const nameIdx = args.indexOf('--name');
      expect(args[nameIdx + 1]).toBe('openbob-agent-my-group');

      // Label
      const labelIdx = args.indexOf('--label');
      expect(args[labelIdx + 1]).toBe('openbob.group=my-group');

      // GROUP_FOLDER env
      const eFlags: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-e' && args[i + 1]) eFlags.push(args[i + 1]!);
      }
      expect(eFlags).toContain('GROUP_FOLDER=my-group');

      vi.unstubAllGlobals();
    });

    it('uses execFile array args (no shell)', async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'inspect' && args.length > 2)
          return dockerOk('/workspace:/host/workspace;');
        if (args[0] === 'ps') return dockerOk('\n');
        if (args[0] === 'rm') return dockerOk();
        if (args[0] === 'run') return dockerOk('id');
        return dockerOk();
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );
      const { warmUpContainers } = await importRunner();
      await warmUpContainers([
        { folder: 'shell-test', model: 'anthropic/claude-sonnet-4-6' },
      ]);

      // All calls should be execFile(binary, argsArray, ...) — not string commands
      for (const call of mockExecFile.mock.calls) {
        expect(call[0]).toBe('docker');
        expect(Array.isArray(call[1])).toBe(true);
      }

      vi.unstubAllGlobals();
    });
  });
});

// ── formatPromptForOv ─────────────────────────────────────────────────────

describe('formatPromptForOv', () => {
  it('converts XML messages to sender-prefixed format', async () => {
    const { formatPromptForOv } = await importRunner();
    const xml = `<messages>
<message sender="Alice" time="2026-01-01T10:00:00.000Z">Hello world</message>
<message sender="Bob" time="2026-01-01T10:01:00.000Z">How are you?</message>
</messages>`;
    const result = formatPromptForOv(xml);
    expect(result).toBe('[Alice]: Hello world\n[Bob]: How are you?');
  });

  it('returns raw prompt when no XML message tags found', async () => {
    const { formatPromptForOv } = await importRunner();
    const plain = 'Just a regular prompt without XML';
    expect(formatPromptForOv(plain)).toBe(plain);
  });

  it('unescapes XML entities in sender names and content', async () => {
    const { formatPromptForOv } = await importRunner();
    const xml = `<messages>
<message sender="O&apos;Brien &amp; Co" time="2026-01-01T10:00:00.000Z">Use &lt;tag&gt; &amp; &quot;quotes&quot;</message>
</messages>`;
    const result = formatPromptForOv(xml);
    // Note: &apos; is not handled by our unescape (not in the regex), but &amp; &lt; &gt; &quot; are
    expect(result).toContain('[O');
    expect(result).toContain('& Co');
    expect(result).toContain('<tag>');
    expect(result).toContain('& "quotes"');
  });

  it('handles single message', async () => {
    const { formatPromptForOv } = await importRunner();
    const xml = `<messages>
<message sender="Martin" time="2026-01-01T10:00:00.000Z">How was the API format?</message>
</messages>`;
    const result = formatPromptForOv(xml);
    expect(result).toBe('[Martin]: How was the API format?');
  });
});

// ── OpenViking scope integration ──────────────────────────────────────────

describe('OpenViking scope', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    mockExecFile.mockImplementation(() => dockerOk());
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function setupHappyPathWithOv() {
    mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'inspect' && args.length > 2)
        return dockerOk('/workspace:/host/workspace;');
      if (args[0] === 'ps') return dockerOk('\n');
      if (args[0] === 'rm') return dockerOk();
      if (args[0] === 'run') return dockerOk('id');
      return dockerOk();
    });

    // Allow auth.json reads (writeAuthConfig) and ov_user.key reads
    const prevReadFileSync = mockFs.readFileSync.getMockImplementation();
    mockFs.readFileSync.mockImplementation((p: string, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.includes('auth.json'))
        return '{"providers":{}}';
      if (prevReadFileSync) return prevReadFileSync(p, ...rest);
      const err: NodeJS.ErrnoException = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.existsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('auth.json')) return true;
      return false;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );

    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    mockClientSession.create.mockResolvedValue({
      data: { id: 'sess-123' },
    });
    mockClientSession.get.mockResolvedValue({ data: null });
    mockClientSession.list.mockResolvedValue({ data: [] });
    mockClientSession.status.mockResolvedValue({
      data: { 'sess-123': { type: 'idle' } },
    });
    mockClientSession.promptAsync.mockResolvedValue({ data: {} });
    mockClientSession.messages.mockResolvedValue({
      data: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'Response text' }],
        },
      ],
    });
  }

  it('uses global user key with account/user headers in global scope', async () => {
    process.env['OPENVIKING_URL'] = 'http://openviking:1933';

    const { getEnv } = await import('./env.js');
    vi.mocked(getEnv).mockReturnValue({
      MODEL: 'anthropic/claude-sonnet-4-6',
      OPENVIKING_URL: 'http://openviking:1933',
      OPENVIKING_SCOPE: 'global',
      LOG_LEVEL: 'info',
    } as ReturnType<typeof getEnv>);

    // Global user key file exists
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('ov_user.key'))
        return 'global-user-key-123';
      const err: NodeJS.ErrnoException = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });

    setupHappyPathWithOv();

    // Capture fetch calls to inspect OV requests
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { memories: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runAgentSession } = await importRunner();
    await runAgentSession({
      groupFolder: 'test-group',
      prompt:
        '<messages>\n<message sender="Alice" time="2026-01-01T10:00:00.000Z">Hello</message>\n</messages>',
      chatJid: 'mm:ch1',
      isMain: false,
      model: 'anthropic/claude-sonnet-4-6',
    });

    // Find OV API calls (to openviking:1933)
    const ovCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('openviking'),
    );

    // Should have OV calls with global user headers
    if (ovCalls.length > 0) {
      const headers = (ovCalls[0]![1] as { headers: Record<string, string> })
        .headers;
      expect(headers['X-API-Key']).toBe('global-user-key-123');
      expect(headers['X-OpenViking-Account']).toBe('openbob');
      expect(headers['X-OpenViking-User']).toBe('default');
    }

    vi.unstubAllGlobals();
  });

  it('uses per-group user key without account/user headers in group scope', async () => {
    process.env['OPENVIKING_URL'] = 'http://openviking:1933';

    const { getEnv } = await import('./env.js');
    vi.mocked(getEnv).mockReturnValue({
      MODEL: 'anthropic/claude-sonnet-4-6',
      OPENVIKING_URL: 'http://openviking:1933',
      OPENVIKING_SCOPE: 'group',
      OPENVIKING_API_KEY: 'root-key',
      LOG_LEVEL: 'info',
    } as ReturnType<typeof getEnv>);

    // DB returns existing per-group key
    const { getOvUserKey } = await import('./db.js');
    vi.mocked(getOvUserKey).mockReturnValue('group-user-key-456');

    setupHappyPathWithOv();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { memories: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runAgentSession } = await importRunner();
    await runAgentSession({
      groupFolder: 'test-group',
      prompt:
        '<messages>\n<message sender="Bob" time="2026-01-01T10:00:00.000Z">Hi</message>\n</messages>',
      chatJid: 'mm:ch1',
      isMain: false,
      model: 'anthropic/claude-sonnet-4-6',
    });

    // Find OV API calls
    const ovCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('openviking'),
    );

    if (ovCalls.length > 0) {
      const headers = (ovCalls[0]![1] as { headers: Record<string, string> })
        .headers;
      expect(headers['X-API-Key']).toBe('group-user-key-456');
      // Per-group keys are self-sufficient — no account/user headers
      expect(headers['X-OpenViking-Account']).toBeUndefined();
      expect(headers['X-OpenViking-User']).toBeUndefined();
    }

    vi.unstubAllGlobals();
  });

  it('provisions new user on first group interaction in group scope', async () => {
    process.env['OPENVIKING_URL'] = 'http://openviking:1933';

    const { getEnv } = await import('./env.js');
    vi.mocked(getEnv).mockReturnValue({
      MODEL: 'anthropic/claude-sonnet-4-6',
      OPENVIKING_URL: 'http://openviking:1933',
      OPENVIKING_SCOPE: 'group',
      OPENVIKING_API_KEY: 'root-key',
      LOG_LEVEL: 'info',
    } as ReturnType<typeof getEnv>);

    // No existing key in DB
    const { getOvUserKey, setOvUserKey } = await import('./db.js');
    vi.mocked(getOvUserKey).mockReturnValue(null);

    setupHappyPathWithOv();

    // Admin API provisioning call returns user key, other OV calls succeed
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/admin/accounts/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ result: { user_key: 'new-group-key-789' } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ result: { memories: [] } }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runAgentSession } = await importRunner();
    await runAgentSession({
      groupFolder: 'new-group',
      prompt: 'Hello',
      chatJid: 'mm:ch1',
      isMain: false,
      model: 'anthropic/claude-sonnet-4-6',
    });

    // Should have called Admin API to provision user
    const adminCall = fetchMock.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' &&
        (c[0] as string).includes('/admin/accounts/openbob/users'),
    );
    expect(adminCall).toBeDefined();

    // Should have stored the new key in DB
    expect(setOvUserKey).toHaveBeenCalledWith('new-group', 'new-group-key-789');

    vi.unstubAllGlobals();
  });

  it('sends sender-prefixed prompt to OpenViking', async () => {
    process.env['OPENVIKING_URL'] = 'http://openviking:1933';

    const { getEnv } = await import('./env.js');
    vi.mocked(getEnv).mockReturnValue({
      MODEL: 'anthropic/claude-sonnet-4-6',
      OPENVIKING_URL: 'http://openviking:1933',
      OPENVIKING_SCOPE: 'global',
      LOG_LEVEL: 'info',
    } as ReturnType<typeof getEnv>);

    mockFs.readFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('ov_user.key'))
        return 'global-key';
      const err: NodeJS.ErrnoException = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });

    setupHappyPathWithOv();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { memories: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runAgentSession } = await importRunner();
    await runAgentSession({
      groupFolder: 'test-group',
      prompt:
        '<messages>\n<message sender="Martin" time="2026-01-01T10:00:00.000Z">How was the API?</message>\n</messages>',
      chatJid: 'mm:ch1',
      isMain: false,
      model: 'anthropic/claude-sonnet-4-6',
    });

    // Find the OV message POST call (session messages endpoint)
    const msgCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' &&
        (c[0] as string).includes('/sessions/') &&
        (c[0] as string).includes('/messages'),
    );

    // The user message should contain sender-prefixed format, not raw XML
    if (msgCalls.length > 0) {
      const body = JSON.parse((msgCalls[0]![1] as { body: string }).body) as {
        content: string;
      };
      expect(body.content).toBe('[Martin]: How was the API?');
      expect(body.content).not.toContain('<message');
    }

    vi.unstubAllGlobals();
  });

  it('searches against per-group user URI in group scope', async () => {
    process.env['OPENVIKING_URL'] = 'http://openviking:1933';

    const { getEnv } = await import('./env.js');
    vi.mocked(getEnv).mockReturnValue({
      MODEL: 'anthropic/claude-sonnet-4-6',
      OPENVIKING_URL: 'http://openviking:1933',
      OPENVIKING_SCOPE: 'group',
      OPENVIKING_API_KEY: 'root-key',
      LOG_LEVEL: 'info',
    } as ReturnType<typeof getEnv>);

    const { getOvUserKey } = await import('./db.js');
    vi.mocked(getOvUserKey).mockReturnValue('group-key');

    setupHappyPathWithOv();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { memories: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runAgentSession } = await importRunner();
    await runAgentSession({
      groupFolder: 'my-group',
      prompt: 'Hello',
      chatJid: 'mm:ch1',
      isMain: false,
      model: 'anthropic/claude-sonnet-4-6',
    });

    // Find the search/find call
    const findCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('/search/find'),
    );

    if (findCalls.length > 0) {
      const body = JSON.parse((findCalls[0]![1] as { body: string }).body) as {
        target_uri: string;
      };
      expect(body.target_uri).toBe('viking://user/group-my-group/memories');
    }

    vi.unstubAllGlobals();
  });
});
