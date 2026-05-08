/**
 * VNC Browser Session management.
 * Starts/stops Xvfb + x11vnc + websockify + Chromium for manual login sessions.
 * Only one VNC session can be active per container at a time.
 * Browser profiles are persisted under /workspace/data/project/.browser-profiles/<name>/
 */

import { execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

const PROFILES_DIR = '/workspace/data/project/.browser-profiles';
const VNC_PORT = 6080; // noVNC websockify port (internal)
const DISPLAY = ':99';

interface ActiveSession {
  name: string;
  xvfbProc: ChildProcess;
  vncProc: ChildProcess;
  websockifyProc: ChildProcess;
  chromiumProc: ChildProcess;
}

let activeSession: ActiveSession | null = null;

function getProfileDir(name: string): string {
  return path.join(PROFILES_DIR, name);
}

export function isVncSessionActive(): boolean {
  return activeSession !== null;
}

export function getActiveVncSessionName(): string | null {
  return activeSession?.name ?? null;
}

export function isProfileLockedByVnc(name: string): boolean {
  return activeSession?.name === name;
}

function spawnProcess(command: string, args: string[]): ChildProcess {
  const proc = execFile(command, args, { timeout: 0 }, () => {});
  // Detach stdio so the process doesn't block
  proc.stdout?.resume();
  proc.stderr?.resume();
  return proc;
}

export async function startVncBrowserSession(
  name: string,
  url?: string,
): Promise<{ port: number; url: string }> {
  if (activeSession) {
    throw new Error(
      `A VNC browser session is already active: "${activeSession.name}". Stop it first with vnc_browser_session_stop.`,
    );
  }

  // Validate name (filesystem-safe)
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(
      'Invalid session name. Use lowercase letters, digits, dots, hyphens, underscores. Max 64 chars.',
    );
  }

  const profileDir = getProfileDir(name);
  fs.mkdirSync(profileDir, { recursive: true });

  // Clean up stale X lock file from previous crash/restart
  const lockFile = '/tmp/.X99-lock';
  try {
    fs.unlinkSync(lockFile);
  } catch {
    // File doesn't exist — expected
  }

  // Clean up stale Chromium singleton locks from previous headless sessions
  for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.unlinkSync(path.join(profileDir, lockName));
    } catch {
      // File doesn't exist — expected
    }
  }

  // 1. Start Xvfb
  const xvfbProc = spawnProcess('Xvfb', [
    DISPLAY,
    '-screen',
    '0',
    '1280x720x24',
    '-ac',
  ]);
  // Give Xvfb a moment to start
  await new Promise((r) => setTimeout(r, 500));

  // 2. Start x11vnc
  const vncArgs = [
    '-display',
    DISPLAY,
    '-forever',
    '-nopw',
    '-rfbport',
    '5900',
    '-shared',
  ];
  const vncPassword = process.env['VNC_PASSWORD'];
  if (vncPassword) {
    vncArgs.splice(vncArgs.indexOf('-nopw'), 1, '-passwd', vncPassword);
  }
  const vncProc = spawnProcess('x11vnc', vncArgs);
  await new Promise((r) => setTimeout(r, 300));

  // 3. Start websockify (noVNC proxy)
  const novncPath = '/usr/share/novnc';
  const websockifyProc = spawnProcess('websockify', [
    '--web',
    novncPath,
    String(VNC_PORT),
    'localhost:5900',
  ]);
  await new Promise((r) => setTimeout(r, 300));

  // 4. Start Chromium (visible, not headless) with DISPLAY set
  const chromiumArgs = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-default-apps',
    '--no-sandbox',
    '--disable-gpu',
    '--window-size=1280,720',
    '--window-position=0,0',
  ];
  if (url) {
    chromiumArgs.push(url);
  }

  const chromiumProc = execFile(
    '/usr/bin/chromium',
    chromiumArgs,
    { env: { ...process.env, DISPLAY }, timeout: 0 },
    () => {},
  );
  chromiumProc.stdout?.resume();
  chromiumProc.stderr?.resume();

  activeSession = {
    name,
    xvfbProc,
    vncProc,
    websockifyProc,
    chromiumProc,
  };

  // Determine the external URL — the host maps VNC_PORT to an external port
  // The agent knows its own hostname but not the external port mapping.
  // We return the internal port; the host/skill will provide the full URL.
  const hostIp = process.env['VNC_HOST_ADDRESS'] ?? 'localhost';
  const externalPort = process.env['VNC_EXTERNAL_PORT'] ?? String(VNC_PORT);

  return {
    port: VNC_PORT,
    url: `http://${hostIp}:${externalPort}/vnc.html?autoconnect=true`,
  };
}

export async function stopVncBrowserSession(name: string): Promise<void> {
  if (!activeSession) {
    throw new Error('No active VNC browser session.');
  }
  if (activeSession.name !== name) {
    throw new Error(
      `Active VNC session is "${activeSession.name}", not "${name}".`,
    );
  }

  // Kill processes in reverse order
  const killProc = (proc: ChildProcess) => {
    try {
      proc.kill('SIGTERM');
    } catch {
      // Process may already be dead
    }
  };

  // SIGTERM Chromium first and give it time for a clean shutdown (removes locks itself)
  killProc(activeSession.chromiumProc);
  await new Promise((r) => setTimeout(r, 3000));

  // Now stop the rest of the stack
  killProc(activeSession.websockifyProc);
  killProc(activeSession.vncProc);
  killProc(activeSession.xvfbProc);
  await new Promise((r) => setTimeout(r, 500));

  // Force kill anything still alive
  for (const proc of [
    activeSession.chromiumProc,
    activeSession.websockifyProc,
    activeSession.vncProc,
    activeSession.xvfbProc,
  ]) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already dead
    }
  }

  // Clean up X lock file
  try {
    await execFileAsync('rm', ['-f', '/tmp/.X99-lock']);
  } catch {
    // Ignore
  }

  // Clean up Chromium singleton locks so headless playwright-cli can use the profile
  const profileDir = getProfileDir(name);
  for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.unlinkSync(path.join(profileDir, lockName));
    } catch {
      // File doesn't exist — expected
    }
  }

  activeSession = null;
}

/**
 * List all persisted browser profiles.
 */
export function listBrowserProfiles(): string[] {
  try {
    return fs
      .readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
