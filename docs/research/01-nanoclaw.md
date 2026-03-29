# NanoClaw - Detailanalyse

**Quelle:** https://github.com/qwibitai/nanoclaw
**Analysiert am:** 2026-03-23
**Stars:** ~25k | **Forks:** ~8.2k

---

## Was ist NanoClaw?

NanoClaw ist ein Personal-AI-Assistant-Framework, das Messaging-Kanäle (WhatsApp, Telegram, Slack, Discord, Gmail) mit Claude-Agenten verbindet, die in isolierten Linux-Containern laufen. Es ist bewusst minimalistisch gehalten — der gesamte Host-Orchestrierungscode besteht aus ~30 TypeScript-Dateien.

---

## Architektur: 3 Schichten

### Schicht 1: Host-Layer (Node.js Prozess)

Der Host ist der zentrale Orchestrierer. Er führt **keinen** Agent-Code direkt aus — er managed Kanäle, routet Nachrichten und startet Container.

**Kern-Module:**
| Modul | Funktion |
|---|---|
| `src/index.ts` | Startup, Kanal-Verbindung, Crash-Recovery |
| `src/router.ts` | Message-Polling (alle 2s via SQLite), Trigger-Matching, Agent-Invokation |
| `src/group-queue.ts` | Per-Gruppe Concurrency-Management, max 5 Container gleichzeitig, Exponential Backoff |
| `src/task-scheduler.ts` | Cron/Interval/One-Shot Task-Scheduling |
| `src/db.ts` | SQLite via `better-sqlite3` (Messages, Sessions, Tasks, Groups) |
| `src/ipc.ts` | IPC-Directory-Watcher für Task-Ops und ausgehende Nachrichten |
| `src/remote-control.ts` | `claude --remote` Subprocess, persisitert Session-URL |
| `src/container-runner.ts` | Docker/Podman-Container spawning mit Volume-Mounts |
| `src/credential-proxy.ts` | HTTP-Proxy zwischen Container und Anthropic API |
| `src/mount-security.ts` | Validierung von Volume-Mounts gegen Allowlist |

### Schicht 2: Channel-Layer (selbst-registrierende Plugins)

Keine Kanäle sind im Core eingebaut. Jeder Kanal (WhatsApp, Telegram, etc.) wird als Git-Branch-Skill geliefert. Das `Channel` Interface erfordert: `name`, `connect/disconnect`, `sendMessage`, `isConnected`, `ownsJid`, optional `sendTyping/sync`.

### Schicht 3: Container-Layer (Linux-VM pro Invokation)

Jeder Agent-Aufruf startet einen frischen Docker/Podman-Container:
- Node.js 22 Base-Image
- Chromium + Playwright für Browser-Automation
- `@anthropic-ai/claude-agent-sdk`
- Container-Skills (`agent-browser`, `status`)

**Container Entry Point (`container/agent-runner/src/index.ts`):**
1. Empfängt `ContainerInput` JSON über stdin
2. `MessageStream` Klasse hält SDK-Query über mehrere User-Turns am Leben
3. Pollt `/workspace/ipc/input/` für Follow-up-Nachrichten
4. Überwacht `_close` Sentinel-File für graceful Shutdown
5. Archiviert Transkripte nach `/workspace/group/conversations/`
6. Output via `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` Sentinels

---

## Agent SDK Integration

- **SDK:** `@anthropic-ai/claude-agent-sdk` v0.2.29
- **Agent-Runner:** Claude Code (`claude --remote`) — proprietär, Anthropic-only
- **Session-Persistenz:** Session-ID in SQLite, `resume` Option im SDK
- **Multi-Turn:** MessageStream-Klasse füttert Nachrichten in offene async-Iterable

---

## Sicherheitsmodell

**Credential-Proxy:**
- Container sehen nur Placeholder-API-Key
- Proxy ersetzt diesen mit echtem Key vor Weiterleitung an Anthropic
- Selbst über env-Variablen, Filesystem oder Prozess-Inspection unauffindbar

**Volume-Mount-Sicherheit:**
- Projekt-Root: **Read-only** gemountet
- `.env`: Leerfile wird darüber gemountet (Shadow)
- Per-Gruppe isolierte `.claude/` Verzeichnisse
- IPC-Directories: Namespace-isoliert pro Gruppe
- Externe Allowlist in `~/.config/nanoclaw/mount-allowlist.json` (außerhalb Projekt-Root)
- Hardcoded Blocklist: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.gcloud`, `.kube`, etc.

**Container-Isolation:**
- Unprivilegierter `node`-User
- Ephemere Container (werden nach Session gelöscht)
- Host-Netzwerk nur über Credential-Proxy erreichbar

---

## Memory & Context-System

3 Ebenen:
1. `groups/CLAUDE.md` — Globaler Kontext, alle Agents lesbar, nur Main schreibbar
2. `groups/{name}/CLAUDE.md` — Per-Gruppe persistentes Memory
3. Zusätzliche `.md` Files im Workspace

Claude Agent SDK's `settingSources: ['project']` lädt diese Files automatisch.

**Schwäche:** Rein file-basiert, kein semantisches Retrieval, keine Hierarchie-Ebenen, kein automatisches Memory-Distillation.

---

## Skills-System

Skills = Git-Branches am Upstream-Repo:
- Install = `git merge skill/telegram`
- Branch-Abhängigkeiten durch Branch-Elternschaft
- GitHub Action hält alle `skill/*` Branches mit main synchron
- Community-Marketplaces durch Fork-Branch-Sets
- Container-Skills: Im Image eingebaut, runtime-verfügbar

**Skill-Typen:**
- Channel-Skills: WhatsApp, Telegram, Discord, Slack, Gmail
- Operational Skills: Setup-/Debug-Workflows (nur Instruktionen)
- Container-Skills: Runtime-Tools im Container (agent-browser, status, etc.)

---

## Tech Stack

| Bereich | Technologie |
|---|---|
| Runtime | Node.js 20+ (Host), Node.js 22 (Container) |
| Sprache | TypeScript (ES-Module) |
| Datenbank | SQLite via `better-sqlite3` |
| Logging | `pino` + `pino-pretty` |
| Validation | `zod`, `yaml` |
| Testing | Vitest |
| Agent SDK | `@anthropic-ai/claude-agent-sdk` 0.2.29 |
| Container | Docker oder Podman |
| Browser | Chromium + Playwright |
| Service | launchd (macOS), systemd (Linux) |

---

## Design-Philosophie

1. **Single Process, no Microservices** — Ein `npm start`, keine Komplexität
2. **Fork-and-Own** — User forken und modifizieren direkt mit Claude Code
3. **Sicherheit durch OS-Primitiven** — Nicht durch Code-Level-Checks
4. **Credential-Proxy als Trust-Boundary** — API-Keys verlassen nie den Host
5. **Atomares IPC via Filesystem** — `tmp` → target rename verhindert partial reads
6. **MessageStream hält SDK am Leben** — Kein Neustart pro Follow-up

---

## Schwachstellen / Einschränkungen

- **Claude Code Lock-in:** Agent-Runner ist proprietär (Anthropic), kein Modell-Wechsel möglich
- **Memory primitive:** CLAUDE.md-Files haben kein semantisches Retrieval
- **Skalierung:** Max 5 Container gleichzeitig (konfigurierbar aber limitiert)
- **Keine Multi-Provider-Unterstützung** im Agent-Layer
