import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';

const mockClose = vi.fn();
const mockCreateServer = vi.fn();

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeServer: mockCreateServer,
}));

describe('agent index', () => {
  let stdoutWrite: Mock;
  let stderrWrite: Mock;
  let processOn: Mock;
  let processExit: Mock;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();

    mockClose.mockReset();
    mockCreateServer.mockReset();
    mockCreateServer.mockResolvedValue({
      url: 'http://0.0.0.0:4096',
      close: mockClose,
    });

    stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true) as unknown as Mock;
    stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true) as unknown as Mock;
    processOn = vi.spyOn(process, 'on') as unknown as Mock;
    processExit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    // Clean env
    process.env = { ...originalEnv };
    delete process.env['OPENCODE_PORT'];
    delete process.env['OPENCODE_LOG_LEVEL'];
    delete process.env['GROUP_FOLDER'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadModule() {
    // Don't await — module hangs on `new Promise<never>`
    // Suppress the unhandled rejection that occurs when the module-level
    // promise is garbage-collected.
    import('./index.js').catch(() => {});
    await vi.waitFor(() => {
      expect(mockCreateServer).toHaveBeenCalled();
    });
    // Give the rest of the module a tick to run (stdout.write, process.on)
    await new Promise((r) => setTimeout(r, 10));
  }

  it('uses default port 4096 when OPENCODE_PORT not set', async () => {
    await loadModule();

    expect(mockCreateServer).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4096 }),
    );
  });

  it('uses custom port from OPENCODE_PORT env', async () => {
    process.env['OPENCODE_PORT'] = '8080';
    await loadModule();

    expect(mockCreateServer).toHaveBeenCalledWith(
      expect.objectContaining({ port: 8080 }),
    );
  });

  it('passes hostname and timeout', async () => {
    await loadModule();

    expect(mockCreateServer).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: '0.0.0.0',
        timeout: 60_000,
      }),
    );
  });

  it('includes OPENCODE_LOG_LEVEL in config when set', async () => {
    process.env['OPENCODE_LOG_LEVEL'] = 'DEBUG';
    await loadModule();

    const config = mockCreateServer.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect((config?.config as Record<string, unknown>)?.logLevel).toBe('DEBUG');
  });

  it('does not include logLevel when OPENCODE_LOG_LEVEL not set', async () => {
    await loadModule();

    const config = mockCreateServer.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(config?.config).not.toHaveProperty('logLevel');
  });

  it('constructs mcpServerPath with mcp-server.js', async () => {
    await loadModule();

    const callArg = mockCreateServer.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    const config = callArg?.config as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(config.mcp.openbob.command).toEqual(
      expect.arrayContaining([expect.stringMatching(/mcp-server\.js$/)]),
    );
    expect(config.mcp.openbob.type).toBe('local');
    expect((config.mcp.openbob.command as string[])[0]).toBe('node');
  });

  it('writes ready message to stdout on success', async () => {
    mockCreateServer.mockResolvedValue({
      url: 'http://0.0.0.0:4096',
      close: mockClose,
    });
    await loadModule();

    const readyCall = stdoutWrite.mock.calls.find((call: string[]) => {
      const arg = call[0];
      return typeof arg === 'string' && arg.includes('"ready":true');
    });
    expect(readyCall).toBeDefined();
    const parsed = JSON.parse(readyCall![0].trim());
    expect(parsed).toEqual({ ready: true, url: 'http://0.0.0.0:4096' });
  });

  it('writes starting message to stdout with GROUP_FOLDER', async () => {
    process.env['GROUP_FOLDER'] = 'test-group';
    await loadModule();

    expect(stdoutWrite).toHaveBeenCalledWith(
      '[agent] group=test-group starting\n',
    );
  });

  it('writes starting message with ? when GROUP_FOLDER not set', async () => {
    await loadModule();

    expect(stdoutWrite).toHaveBeenCalledWith('[agent] group=? starting\n');
  });

  it('writes error to stderr and exits with 1 on failure', async () => {
    mockCreateServer.mockRejectedValue(new Error('connection refused'));

    // Module will crash after mocked exit since server is undefined,
    // but we only care about the error handling path.
    import('./index.js').catch(() => {});
    await vi.waitFor(() => {
      expect(processExit).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(stderrWrite).toHaveBeenCalledWith(
      'createOpencodeServer failed: connection refused\n',
    );
    expect(processExit).toHaveBeenCalledWith(1);
  });

  it('handles non-Error throw and stringifies it', async () => {
    mockCreateServer.mockRejectedValue('raw string error');

    import('./index.js').catch(() => {});
    await vi.waitFor(() => {
      expect(processExit).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(stderrWrite).toHaveBeenCalledWith(
      'createOpencodeServer failed: raw string error\n',
    );
  });

  it('registers SIGTERM handler that closes server and exits', async () => {
    await loadModule();

    const sigtermCall = processOn.mock.calls.find(
      (call: string[]) => call[0] === 'SIGTERM',
    );
    expect(sigtermCall).toBeDefined();

    const handler = sigtermCall![1] as () => void;
    handler();

    expect(mockClose).toHaveBeenCalled();
    expect(processExit).toHaveBeenCalledWith(0);
  });

  it('registers SIGINT handler that closes server and exits', async () => {
    await loadModule();

    const sigintCall = processOn.mock.calls.find(
      (call: string[]) => call[0] === 'SIGINT',
    );
    expect(sigintCall).toBeDefined();

    const handler = sigintCall![1] as () => void;
    handler();

    expect(mockClose).toHaveBeenCalled();
    expect(processExit).toHaveBeenCalledWith(0);
  });
});
