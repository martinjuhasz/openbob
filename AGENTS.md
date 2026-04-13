# AGENTS.md

## Project

openbob — personal AI assistant running agents in isolated Docker containers. Two-layer architecture: **Host** (Node.js orchestrator in `src/`) and **Agent** (OpenCode server per group in `agent/`).

## Tech Stack

- Node.js >=22, ES Modules (`"type": "module"`)
- TypeScript (strict mode), target ES2022, module NodeNext
- SQLite via `better-sqlite3` (DB returns snake_case keys matching column names)
- Vitest for tests, ESLint + Prettier for code quality
- Docker for agent isolation, filesystem IPC between host and agent containers

## Commands

```bash
npm test              # run tests (vitest, src/**/*.test.ts)
npm run typecheck     # tsc --noEmit
npm run lint          # eslint src/
npm run format:check  # prettier check
```

Run all four before considering work complete.

## Code Conventions

- **Imports**: use `.js` extension for local imports (NodeNext resolution)
- **Formatting**: Prettier with single quotes. No other overrides.
- **Unused vars**: prefix with `_` (e.g. `_err`, `_unused`)
- **No `as any`**, no `@ts-ignore`, no `@ts-expect-error`
- **No empty catch blocks** — `eslint-plugin-no-catch-all` enforces this
- **No `@typescript-eslint/no-explicit-any` violations** (warning level, treat as error)
- **DB interfaces use snake_case** (matching SQLite column names), TypeScript interfaces elsewhere use camelCase
- **Tests**: colocated as `*.test.ts` next to source files. Framework is Vitest.

## Architecture

```
src/                     # Host — orchestrator
  index.ts               # startup, polling, message dispatch
  container-runner.ts    # Docker container lifecycle
  router.ts              # trigger detection, message formatting
  group-queue.ts         # per-group concurrency queue
  task-scheduler.ts      # cron/interval/once task runner
  ipc.ts                 # filesystem IPC watcher (agent → host)
  db.ts                  # SQLite persistence
  env.ts                 # zod env validation
  types.ts               # shared type definitions
  channels/              # channel adapters (telegram.ts, matrix.ts, registry.ts)

agent/                   # Agent — runs inside Docker containers
  src/index.ts           # OpenCode server on port 4096
  src/mcp-server.ts      # 12 MCP tools (send_message, schedule_task, list_groups, delete_group, etc.)

workspace/
  AGENTS.md              # agent instructions (mounted read-only into containers)

skills/                  # read-only skill packs mounted at /workspace/skills/ in containers
```

Host and agent are separate npm packages with separate `tsconfig.json`. ESLint only covers `src/` (host). Agent has no tests or linting.

## IPC Mechanism

Agents write JSON files to `/workspace/ipc/tasks/` or `/workspace/ipc/messages/`. Host polls every 2 seconds. For request-response (e.g. `list_tasks`, `list_groups`), agent writes a request, host writes response to `/workspace/ipc/input/`, agent polls up to 10s.

## Key Patterns

- `execFile` over `exec`/`execSync` — no shell injection
- Environment validation via zod schema in `env.ts` — all env vars typed
- Per-group model override via `model` column on `registered_groups` table (nullable)
- Channel adapters self-register in `channels/registry.ts`
- Agent container names: `openbob-agent-<groupFolder>`
- Two-tier config: host writes base `opencode.json` (read-only), agent can override in `project/opencode.json`
- `context.json` at `/workspace/context.json` — updated by host via `fs.writeFileSync` (same inode, visible through Docker file bind mount)
