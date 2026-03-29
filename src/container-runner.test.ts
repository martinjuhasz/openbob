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
const mockClientAuth = vi.hoisted(() => ({
  set: vi.fn(),
}));
const mockCreateOpencodeClient = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    session: mockClientSession,
    auth: mockClientAuth,
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

// ─── Helpers ────────────────────────────────────────────────────────────────

const originalEnv = process.env;

function dockerOk(stdout = ''): Promise<{ stdout: string; stderr: string }> {
  return Promise.resolve({ stdout, stderr: '' });
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
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
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
          'label=yetaclaw.group',
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

      // configureAuth: auth.set succeeds
      process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
      mockClientAuth.set.mockResolvedValue({ data: {} });

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
      expect(runCall![1]).toContain('yetaclaw-agent-test-group');

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
    it('writes opencode.json with model and defaults', async () => {
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
      process.env['ANTHROPIC_API_KEY'] = 'sk-test';
      mockClientAuth.set.mockResolvedValue({ data: {} });

      // No existing opencode.json → readFileSync throws
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
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
      expect(written.model).toBe('anthropic/claude-sonnet-4-6');
      expect(written.provider).toBeUndefined();
      expect(written.share).toBe('disabled');
      expect(written.permission).toEqual({ edit: 'allow', bash: 'allow' });

      vi.unstubAllGlobals();
    });

    it('preserves existing opencode.json fields while updating model', async () => {
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
      process.env['ANTHROPIC_API_KEY'] = 'sk-test';
      mockClientAuth.set.mockResolvedValue({ data: {} });

      // Existing opencode.json with custom MCP tools and permissions
      // Simulates a stale config with old provider.default format
      const existingConfig = {
        provider: { default: 'old-model/old' },
        model: 'old-model/old',
        share: 'enabled',
        permission: { edit: 'deny', bash: 'deny' },
        mcp: { custom_tool: { type: 'local', command: 'node tool.js' } },
      };
      mockFs.readFileSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('opencode.json'))
          return JSON.stringify(existingConfig);
        throw new Error('ENOENT');
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
      // Model updated via top-level key
      expect(written.model).toBe('openrouter/anthropic/claude-opus-4');
      // Stale provider.default cleaned up
      expect(written.provider).toBeUndefined();
      // Existing fields preserved (not overwritten with defaults)
      expect(written.share).toBe('enabled');
      expect(written.permission).toEqual({ edit: 'deny', bash: 'deny' });
      // Custom MCP tools preserved
      expect(written.mcp.custom_tool.command).toBe('node tool.js');

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
      mockClientAuth.set.mockResolvedValue({ data: {} });

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

  // ── configureAuth (tested via warmUp → spawn → configure) ──────────────

  describe('configureAuth', () => {
    it('calls auth.set with provider derived from model string', async () => {
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
      process.env['OPENROUTER_API_KEY'] = 'sk-or-test';
      mockClientAuth.set.mockResolvedValue({ data: {} });

      const { warmUpContainers } = await importRunner();
      await warmUpContainers([
        {
          folder: 'auth-group',
          model: 'openrouter/anthropic/claude-sonnet-4-6',
        },
      ]);

      expect(mockClientAuth.set).toHaveBeenCalledWith({
        path: { id: 'openrouter' },
        body: { type: 'api', key: 'sk-or-test' },
      });

      vi.unstubAllGlobals();
    });

    it('skips auth.set when no matching API key env var exists', async () => {
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
      // No API key set for anthropic
      delete process.env['ANTHROPIC_API_KEY'];
      mockClientAuth.set.mockResolvedValue({ data: {} });

      const { warmUpContainers } = await importRunner();
      await warmUpContainers([
        { folder: 'noauth-group', model: 'anthropic/claude-sonnet-4-6' },
      ]);

      expect(mockClientAuth.set).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
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

      process.env['ANTHROPIC_API_KEY'] = 'sk-test';
      mockClientAuth.set.mockResolvedValue({ data: {} });

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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contextCall = (mockFs.writeFileSync.mock.calls as any[]).find(
        (c) => typeof c[0] === 'string' && c[0].endsWith('context.json'),
      );
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
      mockClientAuth.set.mockResolvedValue({ data: {} });

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
      expect(args[nameIdx + 1]).toBe('yetaclaw-agent-my-group');

      // Label
      const labelIdx = args.indexOf('--label');
      expect(args[labelIdx + 1]).toBe('yetaclaw.group=my-group');

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
      mockClientAuth.set.mockResolvedValue({ data: {} });

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
