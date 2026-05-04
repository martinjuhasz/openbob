// Docker Compose management — validates compose files and executes
// docker compose commands in the project directory of a group.

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

import yaml from 'js-yaml';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import type { composeSchema } from './ipc-schemas.js';
import type { z } from 'zod';

export type ComposeAction = z.infer<typeof composeSchema>['action'];

export interface ComposeResult {
  success: boolean;
  output?: string;
  error?: string;
}

/** Compose file names to search for, in priority order. */
const COMPOSE_FILE_NAMES = [
  'compose.yml',
  'compose.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
];

/** Dangerous capabilities that should be blocked. */
const DANGEROUS_CAPS = new Set([
  'ALL',
  'SYS_ADMIN',
  'SYS_PTRACE',
  'NET_ADMIN',
  'NET_RAW',
  'SYS_RAWIO',
  'SYS_MODULE',
  'DAC_OVERRIDE',
]);

/** Timeout per action in milliseconds. */
const ACTION_TIMEOUTS: Record<ComposeAction, number> = {
  up: 120_000,
  down: 60_000,
  build: 300_000,
  logs: 30_000,
  ps: 15_000,
  restart: 120_000,
};

/**
 * Find a compose file in the given project directory.
 * Returns the absolute path or null if not found.
 */
export function findComposeFile(projectDir: string): string | null {
  for (const name of COMPOSE_FILE_NAMES) {
    const filePath = path.join(projectDir, name);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

export interface ValidationResult {
  valid: boolean;
  violations: string[];
}

/**
 * Validate a docker-compose file for dangerous configurations.
 * Checks each service for privileged mode, host networking,
 * docker socket mounts, dangerous capabilities, etc.
 */
export function validateComposeFile(
  filePath: string,
  projectDir: string,
): ValidationResult {
  const violations: string[] = [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
    // eslint-disable-next-line no-catch-all/no-catch-all -- file read failure
  } catch (err) {
    return {
      valid: false,
      violations: [
        `Cannot read compose file: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  let doc: unknown;
  try {
    doc = yaml.load(content);
    // eslint-disable-next-line no-catch-all/no-catch-all -- YAML parse failure
  } catch (err) {
    return {
      valid: false,
      violations: [
        `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  if (!doc || typeof doc !== 'object') {
    return { valid: false, violations: ['Compose file is empty or invalid'] };
  }

  const root = doc as Record<string, unknown>;
  const services = root.services;
  if (!services || typeof services !== 'object') {
    // No services defined — nothing dangerous, but also nothing to do
    return { valid: true, violations: [] };
  }

  const resolvedProjectDir = path.resolve(projectDir);

  for (const [serviceName, serviceDef] of Object.entries(
    services as Record<string, unknown>,
  )) {
    if (!serviceDef || typeof serviceDef !== 'object') continue;
    const svc = serviceDef as Record<string, unknown>;

    // Check privileged
    if (svc.privileged === true) {
      violations.push(
        `Service "${serviceName}": privileged mode is not allowed`,
      );
    }

    // Check network_mode
    if (svc.network_mode === 'host') {
      violations.push(
        `Service "${serviceName}": network_mode "host" is not allowed`,
      );
    }

    // Check pid
    if (svc.pid === 'host') {
      violations.push(`Service "${serviceName}": pid "host" is not allowed`);
    }

    // Check ipc
    if (svc.ipc === 'host') {
      violations.push(`Service "${serviceName}": ipc "host" is not allowed`);
    }

    // Check cap_add
    if (Array.isArray(svc.cap_add)) {
      for (const cap of svc.cap_add) {
        if (typeof cap === 'string' && DANGEROUS_CAPS.has(cap.toUpperCase())) {
          violations.push(
            `Service "${serviceName}": capability "${cap}" is not allowed`,
          );
        }
      }
    }

    // Check volumes for docker socket and path escapes
    if (Array.isArray(svc.volumes)) {
      for (const vol of svc.volumes) {
        if (typeof vol === 'string') {
          validateVolumeString(
            vol,
            serviceName,
            resolvedProjectDir,
            violations,
          );
        } else if (vol && typeof vol === 'object') {
          const volObj = vol as Record<string, unknown>;
          if (typeof volObj.source === 'string') {
            validateVolumePath(
              volObj.source,
              serviceName,
              resolvedProjectDir,
              violations,
            );
          }
        }
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

function validateVolumeString(
  vol: string,
  serviceName: string,
  projectDir: string,
  violations: string[],
): void {
  // Format: [source:]target[:options]
  const parts = vol.split(':');
  if (parts.length >= 2) {
    const source = parts[0]!;
    // Skip named volumes (no path separator)
    if (
      source.startsWith('/') ||
      source.startsWith('.') ||
      source.startsWith('~')
    ) {
      validateVolumePath(source, serviceName, projectDir, violations);
    }
  }
}

function validateVolumePath(
  source: string,
  serviceName: string,
  projectDir: string,
  violations: string[],
): void {
  // Block docker socket
  if (
    source === '/var/run/docker.sock' ||
    source === '/run/docker.sock' ||
    source.includes('docker.sock')
  ) {
    violations.push(
      `Service "${serviceName}": mounting Docker socket is not allowed`,
    );
    return;
  }

  // Resolve relative paths against project dir
  const resolved = path.resolve(projectDir, source);

  // Must be within project directory
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    violations.push(
      `Service "${serviceName}": volume mount "${source}" escapes project directory`,
    );
  }
}

/**
 * Execute a docker compose command in the project directory.
 */
export function executeCompose(
  action: ComposeAction,
  projectDir: string,
  composeFile: string,
  options: {
    services?: string[];
    lines?: number;
    removeVolumes?: boolean;
  } = {},
): Promise<ComposeResult> {
  const args = ['compose', '-f', composeFile];

  switch (action) {
    case 'up':
      args.push('up', '-d');
      if (options.services?.length) args.push(...options.services);
      break;
    case 'down':
      args.push('down');
      if (options.removeVolumes) args.push('-v');
      break;
    case 'build':
      args.push('build');
      if (options.services?.length) args.push(...options.services);
      break;
    case 'logs':
      args.push('logs', '--tail', String(options.lines ?? 100), '--no-color');
      if (options.services?.length) args.push(...options.services);
      break;
    case 'ps':
      args.push('ps', '--format', 'table');
      break;
    case 'restart':
      args.push('restart');
      if (options.services?.length) args.push(...options.services);
      break;
  }

  const timeout = ACTION_TIMEOUTS[action];

  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      args,
      {
        cwd: projectDir,
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
      },
      (err, stdout, stderr) => {
        if (err) {
          const output = [stdout, stderr].filter(Boolean).join('\n').trim();
          resolve({
            success: false,
            error: output || (err instanceof Error ? err.message : String(err)),
          });
        } else {
          const output = [stdout, stderr].filter(Boolean).join('\n').trim();
          resolve({ success: true, output: output || '(no output)' });
        }
      },
    );

    // Safety: kill on timeout (execFile handles this but just in case)
    child.on('error', (err) => {
      resolve({
        success: false,
        error: err.message,
      });
    });
  });
}

/**
 * Handle a compose IPC request from an agent.
 * Finds the compose file, validates it, and executes the requested action.
 */
export async function handleComposeIpc(
  data: {
    action: ComposeAction;
    services?: string[];
    lines?: number;
    removeVolumes?: boolean;
  },
  sourceGroup: string,
): Promise<ComposeResult> {
  const projectDir = path.join(GROUPS_DIR, sourceGroup, 'project');

  if (!fs.existsSync(projectDir)) {
    return {
      success: false,
      error: `Project directory not found: ${projectDir}`,
    };
  }

  const composeFile = findComposeFile(projectDir);
  if (!composeFile) {
    return {
      success: false,
      error: `No compose file found in project directory. Expected one of: ${COMPOSE_FILE_NAMES.join(', ')}`,
    };
  }

  // Validate compose file before executing any mutating action
  // (skip validation for read-only actions: logs, ps)
  if (data.action !== 'logs' && data.action !== 'ps') {
    const validation = validateComposeFile(composeFile, projectDir);
    if (!validation.valid) {
      return {
        success: false,
        error: `Compose file validation failed:\n${validation.violations.join('\n')}`,
      };
    }
  }

  logger.info(
    { sourceGroup, action: data.action, composeFile },
    'Executing docker compose action',
  );

  return executeCompose(data.action, projectDir, composeFile, {
    services: data.services,
    lines: data.lines,
    removeVolumes: data.removeVolumes,
  });
}
