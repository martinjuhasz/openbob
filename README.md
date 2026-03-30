# yetaclaw

**yet another claw** — A personal AI assistant that runs agents in isolated Docker containers. Loosely based on [NanoClaw](https://github.com/qwibitai/nanoclaw), but built on [OpenCode](https://opencode.ai) instead of Claude Code, supporting 75+ LLM providers, and with optional [OpenViking](https://github.com/open-viking/open-viking) semantic memory.

## What It Does

yetaclaw connects to your messaging platform, watches for a trigger word, and routes messages to an AI agent running in its own isolated Docker container. Each group/channel gets a dedicated agent with its own workspace, session history, and filesystem — fully sandboxed from the host and other groups.

```
Telegram / Mattermost (or other channel)
        |
Host (Node.js) — polls messages, routes to groups
        |
Docker container (per group) — isolated agent sandbox
        |
OpenCode server — LLM agent loop, tools, session persistence
        |  (optional)
OpenViking — semantic memory across sessions
        |
Response back via IPC -> Host -> Channel
```

## Features

- **Multi-channel messaging** — Supports Telegram and Mattermost. Architecture is extensible via channel registry.
- **Isolated group context** — Each group gets its own Docker container, workspace, `opencode.json` config, and session history.
- **Main channel** — A privileged admin channel that can register new groups and manage the system.
- **Scheduled tasks** — Cron, interval, or one-shot tasks that spin up the agent and can message results back.
- **Web access** — Agents have Chromium and `agent-browser` CLI for browsing, screenshots, and web interaction.
- **Per-group model override** — Different groups can use different LLM models.
- **MCP tools** — Agents have access to custom tools (send messages, schedule tasks, manage groups) via the Model Context Protocol.
- **Skills** — Read-only skill packs mounted into containers (e.g., `agent-browser`, `status`).
- **OpenViking memory** (optional) — Semantic recall and storage across sessions. Agents build up knowledge over time.

## Quick Start

### Prerequisites

- Docker + Docker Compose
- A messaging platform: **Telegram bot** (token from [@BotFather](https://t.me/BotFather)) or **Mattermost** instance with a bot account
- An API key for your LLM provider (e.g., Anthropic, OpenRouter)

### Setup

```bash
git clone https://github.com/your-username/yetaclaw.git
cd yetaclaw
cp .env.example .env
```

Edit `.env` with your configuration:

```bash
# Absolute path on the host machine for persistent data
DATA_PATH=/opt/yetaclaw/data

# LLM model — format: providerID/modelID
MODEL=anthropic/claude-sonnet-4-6

# --- Channel: pick Telegram OR Mattermost (or both) ---

# Telegram
TELEGRAM_BOT_TOKEN=your-bot-token

# Mattermost
MATTERMOST_URL=https://your-mattermost.com
MATTERMOST_TOKEN=your-bot-token
```

### Initial Channel Setup

On first run, yetaclaw needs at least one registered group to monitor. Set the `INITIAL_GROUP_*` env vars to bootstrap it — the channel type is detected automatically from the JID prefix (`tg:` → Telegram, `mm:` → Mattermost).

**Step 1: Get your Chat ID**

Start yetaclaw with the channel credentials set (e.g. `TELEGRAM_BOT_TOKEN`). Then:

- **Telegram**: Send `/chatid` to your bot in the target chat. It replies with the JID, e.g. `tg:-1001234567890`.
- **Mattermost**: The channel ID is visible in the channel URL or via the Mattermost API. Prefix it: `mm:your-channel-id`.

**Step 2: Configure the initial group**

Add to your `.env`:

```bash
# Telegram example
INITIAL_GROUP_JID=tg:-1001234567890
INITIAL_GROUP_TRIGGER=yetaclaw

# Mattermost example
# INITIAL_GROUP_JID=mm:your-channel-id
# INITIAL_GROUP_TRIGGER=yetaclaw
```

Optional overrides (sensible defaults are applied):

```bash
INITIAL_GROUP_NAME=Main            # display name (default: "Main")
INITIAL_GROUP_FOLDER=main          # workspace folder (default: "main")
INITIAL_GROUP_IS_MAIN=true         # admin privileges (default: true)
```

**Step 3: Restart** — the group is persisted to the database. After the first run, these env vars are ignored for that JID (it won't overwrite existing entries).

> Additional groups can be registered at runtime via the `register_group` MCP tool from the main channel's agent.

Copy your OpenCode auth credentials:

```bash
mkdir -p ${DATA_PATH}/opencode
cp ~/.local/share/opencode/auth.json ${DATA_PATH}/opencode/auth.json
```

Build and start:

```bash
docker compose build
docker compose up -d
```

To enable OpenViking memory:

```bash
docker compose --profile memory up -d
```

### First Message

In your configured channel, mention the trigger word:

```
@yetaclaw hello, what can you do?
```

The agent will spin up a container, process the message, and respond in the channel.

## Architecture

### Host (`src/`)

Single Node.js process that orchestrates everything:

| File                     | Purpose                                               |
| ------------------------ | ----------------------------------------------------- |
| `index.ts`               | Main loop — startup, polling, message dispatch        |
| `container-runner.ts`    | Spawns/manages Docker containers, OpenCode SDK client |
| `channels/mattermost.ts` | Mattermost channel adapter                            |
| `channels/telegram.ts`   | Telegram channel adapter                              |
| `channels/registry.ts`   | Channel self-registration                             |
| `router.ts`              | Message formatting, trigger detection, routing        |
| `group-queue.ts`         | Per-group message queue with concurrency control      |
| `task-scheduler.ts`      | Cron/interval/one-shot task execution                 |
| `ipc.ts`                 | Filesystem IPC watcher (agent → host communication)   |
| `db.ts`                  | SQLite — messages, groups, sessions, tasks, state     |
| `env.ts`                 | Environment validation (zod)                          |

### Agent (`agent/`)

Runs inside each Docker container:

| File            | Purpose                                                            |
| --------------- | ------------------------------------------------------------------ |
| `index.ts`      | Starts OpenCode server on port 4096                                |
| `mcp-server.ts` | MCP tools: `send_message`, `schedule_task`, `register_group`, etc. |

### Container Lifecycle

1. Host receives a message for a group
2. `getAgentContainer()` checks if a container exists or spawns a new one
3. `writeOpencodeConfig()` writes/merges `opencode.json` with model config into the group workspace
4. Container starts, OpenCode server boots on port 4096
5. Host sends prompt via `client.session.promptAsync()`, polls for completion
6. Agent processes the prompt, can call MCP tools (send messages, schedule tasks) via filesystem IPC
7. Host collects the response and posts it to the channel
8. Container stays warm for subsequent messages

### Docker Network

All containers share the `yetaclaw` Docker network. The host reaches agent containers by name (`yetaclaw-agent-<group>`), no published ports needed.

```
┌─────────────────────────────────────────────┐
│ Docker network: yetaclaw                    │
│                                             │
│  yetaclaw-host ──HTTP──> yetaclaw-agent-*   │
│       │                       │             │
│       │                  OpenCode :4096     │
│       │                       │             │
│       └──IPC (filesystem)─────┘             │
│                                             │
│  yetaclaw-openviking (optional, :1933)      │
└─────────────────────────────────────────────┘
```

## Configuration

### Environment Variables

| Variable                | Required  | Description                                                     |
| ----------------------- | --------- | --------------------------------------------------------------- |
| `DATA_PATH`             | Yes       | Absolute host path for persistent data                          |
| `MODEL`                 | Yes       | Default model, e.g. `anthropic/claude-sonnet-4-6`               |
| `TELEGRAM_BOT_TOKEN`    | Channel   | Telegram bot token (from @BotFather)                            |
| `MATTERMOST_URL`        | Channel   | Mattermost server URL                                           |
| `MATTERMOST_TOKEN`      | Channel   | Mattermost bot account token                                    |
| `INITIAL_GROUP_JID`     | First run | Channel JID — prefix determines channel (`tg:` / `mm:`)         |
| `INITIAL_GROUP_NAME`    | No        | Display name (default: `Main`)                                  |
| `INITIAL_GROUP_FOLDER`  | No        | Workspace folder name (default: `main`)                         |
| `INITIAL_GROUP_TRIGGER` | No        | Trigger word (default: assistant name)                          |
| `INITIAL_GROUP_IS_MAIN` | No        | `true` for admin channel (default: `true`)                      |
| `LOG_LEVEL`             | No        | `trace` / `debug` / `info` / `warn` / `error` (default: `info`) |
| `AGENT_FORWARD_ENV`     | No        | Comma-separated env vars to forward to agent containers         |
| `OPENVIKING_URL`        | No        | OpenViking API URL (default: `http://openviking:1933`)          |

### Per-Group Config (`opencode.json`)

Each group's workspace contains an `opencode.json` that OpenCode reads on startup. The host writes the model config automatically, but agents can edit it to add MCP tools, change permissions, or customize behavior:

```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "share": "disabled",
  "permission": {
    "edit": "allow",
    "bash": "allow"
  },
  "mcp": {
    "custom-tool": {
      "type": "local",
      "command": ["node", "my-tool.js"]
    }
  }
}
```

### Per-Group Model Override

Groups can use different models. Set the `model` field when registering a group (via MCP tool or database), and it overrides the global `MODEL` env var for that group.

## MCP Tools (Available to Agents)

| Tool                                         | Description                                   | Restriction                  |
| -------------------------------------------- | --------------------------------------------- | ---------------------------- |
| `send_message`                               | Send a message to the chat immediately        | Own group only (unless main) |
| `schedule_task`                              | Create cron/interval/one-shot scheduled tasks | Own group only (unless main) |
| `cancel_task` / `pause_task` / `resume_task` | Manage scheduled tasks                        | Own group only (unless main) |
| `register_group`                             | Register a new channel/group                  | Main group only              |
| `update_group`                               | Update group config (trigger, model, etc.)    | Main group only              |

## Skills

Skills are read-only instruction packs mounted at `/skills` inside agent containers. Each skill has a `SKILL.md` file that teaches the agent a capability.

Built-in skills:

| Skill           | Description                                         |
| --------------- | --------------------------------------------------- |
| `agent-browser` | Web browsing via Chromium and `agent-browser` CLI   |
| `status`        | System status reporting (containers, health, tasks) |

## Development

```bash
# Install dependencies
npm install
cd agent && npm install && cd ..

# Type checking
npm run typecheck

# Linting
npm run lint

# Tests
npm test

# Dev mode (without Docker)
npm run dev

# Build
npm run build
docker compose build
```

### Project Structure

```
yetaclaw/
├── src/                    # Host application
│   ├── channels/           # Channel adapters (Telegram, Mattermost, ...)
│   ├── index.ts            # Orchestrator main loop
│   ├── container-runner.ts # Docker container management
│   ├── db.ts               # SQLite database
│   ├── ipc.ts              # Filesystem IPC
│   ├── router.ts           # Message routing
│   ├── group-queue.ts      # Concurrency control
│   └── task-scheduler.ts   # Scheduled task runner
├── agent/                  # Agent container code
│   └── src/
│       ├── index.ts        # OpenCode server startup
│       └── mcp-server.ts   # MCP tools for the agent
├── workspace/
│   ├── groups/             # Per-group workspaces
│   └── global/             # Shared files (AGENTS.md)
├── skills/                 # Skill packs (read-only in containers)
├── openviking/             # OpenViking config + Dockerfile
├── docker-compose.yml
├── Dockerfile              # Host container
└── agent/Dockerfile        # Agent container
```

## Credits

Loosely based on [NanoClaw](https://github.com/qwibitai/nanoclaw) by [Qwibit AI](https://github.com/qwibitai). yetaclaw replaces the Claude Code agent runner with [OpenCode](https://opencode.ai) and adds optional [OpenViking](https://github.com/open-viking/open-viking) semantic memory, making it provider-agnostic and independently extensible.

## License

MIT
