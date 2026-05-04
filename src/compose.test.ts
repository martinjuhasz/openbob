import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  findComposeFile,
  validateComposeFile,
  handleComposeIpc,
} from './compose.js';

vi.mock('./config.js', () => ({
  GROUPS_DIR: '/data/groups',
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('findComposeFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('finds compose.yml', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return String(p).endsWith('compose.yml');
    });
    expect(findComposeFile('/project')).toBe('/project/compose.yml');
  });

  it('finds docker-compose.yml when compose.yml does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return String(p).endsWith('docker-compose.yml');
    });
    expect(findComposeFile('/project')).toBe('/project/docker-compose.yml');
  });

  it('returns null when no compose file exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(findComposeFile('/project')).toBeNull();
  });

  it('prefers compose.yml over docker-compose.yml', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(findComposeFile('/project')).toBe('/project/compose.yml');
  });
});

describe('validateComposeFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockComposeFile(content: string) {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(content);
  }

  it('passes a valid compose file', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    ports:
      - "8080:80"
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('rejects privileged mode', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    privileged: true
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('privileged');
  });

  it('rejects network_mode host', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    network_mode: host
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('network_mode');
  });

  it('rejects pid host', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    pid: host
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('pid');
  });

  it('rejects ipc host', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    ipc: host
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('ipc');
  });

  it('rejects dangerous capabilities', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    cap_add:
      - SYS_ADMIN
      - NET_ADMIN
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toContain('SYS_ADMIN');
    expect(result.violations[1]).toContain('NET_ADMIN');
  });

  it('allows safe capabilities', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    cap_add:
      - CHOWN
      - SETUID
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(true);
  });

  it('rejects docker socket mount (short syntax)', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('Docker socket');
  });

  it('rejects docker socket mount (long syntax)', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    volumes:
      - type: bind
        source: /var/run/docker.sock
        target: /var/run/docker.sock
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('Docker socket');
  });

  it('rejects volume mounts escaping project directory', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    volumes:
      - /etc/passwd:/etc/passwd:ro
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('escapes project directory');
  });

  it('rejects relative path traversal in volumes', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    volumes:
      - ../../etc/passwd:/etc/passwd
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('escapes project directory');
  });

  it('allows volumes within project directory', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    volumes:
      - ./data:/app/data
      - ./config:/app/config:ro
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(true);
  });

  it('allows named volumes', () => {
    mockComposeFile(`
services:
  db:
    image: postgres
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(true);
  });

  it('reports multiple violations across services', () => {
    mockComposeFile(`
services:
  web:
    image: nginx
    privileged: true
  db:
    image: postgres
    network_mode: host
    cap_add:
      - ALL
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(3);
  });

  it('handles invalid YAML', () => {
    mockComposeFile('{{invalid yaml');
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('Invalid YAML');
  });

  it('handles unreadable file', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('Cannot read');
  });

  it('handles empty file', () => {
    mockComposeFile('');
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('empty or invalid');
  });

  it('handles compose file with no services', () => {
    mockComposeFile(`
version: "3"
networks:
  default:
`);
    const result = validateComposeFile('/project/compose.yml', '/project');
    expect(result.valid).toBe(true);
  });
});

describe('handleComposeIpc', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when project directory does not exist', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const result = await handleComposeIpc({ action: 'ps' }, 'test-group');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Project directory not found');
  });

  it('returns error when no compose file found', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      // Project dir exists, but no compose files
      return String(p) === path.join('/data/groups', 'test-group', 'project');
    });
    const result = await handleComposeIpc({ action: 'up' }, 'test-group');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No compose file found');
  });
});
