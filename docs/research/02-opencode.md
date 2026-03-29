# OpenCode - Detailanalyse

**Quelle:** https://opencode.ai / https://github.com/sst/opencode
**Analysiert am:** 2026-03-23
**Stars:** ~129k | **Forks:** ~13.6k | **Releases:** 738+
**Lizenz:** MIT | **Maintainer:** SST (anomalyco)

---

## Was ist OpenCode?

OpenCode ist ein vollständig Open-Source AI-Coding-Agent, der als Terminal-Interface (TUI), Desktop-App und IDE-Extension verfügbar ist. Es wurde von Neovim-Usern für Terminal-Workflows gebaut und unterstützt 75+ LLM-Provider. Es positioniert sich als direkte Alternative zu Claude Code.

---

## Architektur: Client/Server

### Backend (TypeScript / Bun)

```
opencode serve   →   HTTP-Server (Hono) auf lokalem Port
                     SSE-Endpoint für Events
                     OpenAPI-Spec → Auto-generiertes SDK
```

**Key-Klassen:**
| Klasse | Funktion |
|---|---|
| `Server.App` | HTTP/SSE-Routing via Hono |
| `SessionPrompt` | Orchestriert den Agent-Loop |
| `Provider.getModel()` | Löst Model-IDs auf, Multi-Provider |
| `Provider.list()` | Lädt Provider-Konfigurationen |
| `Tool.define()` | Registriert Tools |
| `GlobalBus` | Event-Broadcasting via SSE |

**Session-Persistenz:** SQLite via Drizzle ORM (`sessions.db`)

### Frontend-Clients

- **TUI:** Go-basiertes Terminal-Interface (Primär-Client)
- **Desktop:** Electron-App, Beta (macOS, Windows, Linux)
- **SDK:** `@opencode-ai/sdk` — TypeScript/JavaScript Client, auto-generiert aus OpenAPI-Spec
- **IDE:** VSCode Extension

Der Backend-Server ist von den Clients vollständig entkoppelt — jeder HTTP-Client kann sich verbinden.

---

## Agent-Loop (Core)

```
System Prompt + Tools + User Input
        ↓
    LLM API (via AI SDK streamText)
        ↓
    Model Response (Text + Tool Calls)
        ↓
    Tool Execution (auf User-Maschine)
        ↓
    Results → zurück in Kontext
        ↓
    Loop bis Completion-Bedingung
```

**SDK:** Vercel AI SDK `streamText` — multi-step tool usage, Events: `tool-call` → `tool-result`

---

## Built-in Tools

| Tool | Funktion |
|---|---|
| Read/Write/Edit | Datei-Operationen mit Safety-Checks (absolute Pfade, Size-Limits) |
| Bash | Shell-Ausführung mit Permission-Gates |
| LSP-Integration | Language Server Protocol Diagnostics nach File-Änderungen |
| TodoRead/TodoWrite | Session-scoped Task-Tracking |
| Task | Subagent-Invokation |
| MCP-Server-Support | Erweiterbare Tools via Model Context Protocol |

---

## Agent-Typen (via Tab-Taste)

| Agent | Modus | Beschreibung |
|---|---|---|
| `build` | Voll-Zugriff | Standard-Agent, kann lesen/schreiben/ausführen |
| `plan` | Read-only | Analysiert, schlägt vor, kein Schreiben standardmäßig |
| `general` | Subagent | Für komplexe Searches, via `@general` Syntax |

---

## Provider-Unterstützung

75+ LLM-Provider via Models.dev:
- **Anthropic** (Claude 3.5/4.x)
- **OpenAI** (GPT-4o, o1, etc.)
- **Google** (Gemini)
- **Lokale Modelle** (Ollama, vLLM, etc.)
- **GitHub Copilot** (Login-basiert)
- **ChatGPT Plus/Pro** (Login-basiert)
- **OpenCode Zen** (Kuratierte, getestete Modelle — OpenCode-eigener Service)

Provider-Config: `~/.opencode/config.json` oder via `/connect` Command

---

## Session-Management

- **Persistenz:** SQLite (Drizzle ORM), `sessions.db`
- **Git-Snapshots:** Vor jedem Agent-Schritt wird Working-State gesichert → Rollback möglich
- **Undo/Redo:** `/undo` und `/redo` Commands
- **Session-Sharing:** `/share` erstellt öffentlichen Link (z.B. `opencode.ai/s/4XP1fce5`)
- **Automatische Zusammenfassung:** Bei Token-Limit-Annäherung

---

## Kommunikationsprotokoll

**Starten:**
```bash
opencode serve   # Startet HTTP-Server
opencode         # Startet TUI (verbindet sich mit Server)
```

**API:**
- HTTP REST + SSE (Server-Sent Events)
- TypeScript SDK (`@opencode-ai/sdk`) auto-generiert aus OpenAPI
- Alle Events via `GlobalBus` → SSE-Stream an alle Clients

---

## Wichtige Commands

| Command | Funktion |
|---|---|
| `/init` | Analysiert Projekt, erstellt `AGENTS.md` |
| `/connect` | Konfiguriert LLM-Provider API-Keys |
| `/undo` | Revertiert Änderungen |
| `/redo` | Stellt Änderungen wieder her |
| `/share` | Erstellt shareable Conversation-Link |

---

## Installation

```bash
# Quick Install
curl -fsSL https://opencode.ai/install | bash

# Package Manager
npm install -g opencode
brew install opencode   # macOS
# + Scoop, pacman, nix, etc.
```

---

## Differenzierung zu Claude Code

| Merkmal | Claude Code | OpenCode |
|---|---|---|
| Open Source | Nein | Ja (MIT) |
| LLM-Provider | Nur Anthropic | 75+ Provider |
| LSP | Nein | Ja |
| Architektur | Monolithisch | Client/Server |
| TUI | Ja | Ja (Go-based) |
| Desktop-App | Nein | Ja (Beta) |
| API/SDK | Nein | Ja (HTTP/SSE) |
| Preis | Kostenpflichtig | Kostenlos (eigene Keys) |

---

## `@opencode-ai/sdk` — Vollständige API-Referenz

```bash
npm install @opencode-ai/sdk
```

### Client erstellen

```typescript
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk"

// Startet Server + Client zusammen
const { client } = await createOpencode({
  hostname: "127.0.0.1",
  port: 4096,
  config: { model: "anthropic/claude-3-5-sonnet-20241022" }
})

// Oder: Nur Client für bereits laufenden Server
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" })
```

### Sessions API

```typescript
// Session erstellen
const session = await client.session.create({ body: { title: "My session" } })

// Prompt senden (löst Agent-Loop aus → AssistantMessage)
const result = await client.session.prompt({
  path: { id: session.data.id },
  body: {
    model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    parts: [{ type: "text", text: "Hello!" }]
  }
})

// Kontext injizieren ohne AI-Antwort (noReply: true → nur UserMessage)
await client.session.prompt({
  path: { id: session.data.id },
  body: {
    noReply: true,
    parts: [{ type: "text", text: "Du bist ein persönlicher Assistent." }]
  }
})

// Session abbrechen
await client.session.abort({ path: { id: session.data.id } })

// Messages lesen
const messages = await client.session.messages({ path: { id: session.data.id } })
```

### Events API (SSE)

```typescript
const events = await client.event.subscribe()
for await (const event of events.stream) {
  console.log(event.type, event.properties)
}
```

### Weitere APIs

| API | Methoden |
|---|---|
| `global` | `health()` → version check |
| `app` | `agents()` → verfügbare Agenten |
| `config` | `get()`, `providers()` → Model-Liste |
| `find` | `text()`, `files()`, `symbols()` |
| `file` | `read()`, `status()` |
| `auth` | `set()` → API-Key setzen |
| `tui` | `appendPrompt()`, `submitPrompt()`, `showToast()`, etc. |

### Structured Output

```typescript
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: "Research Anthropic" }],
    format: {
      type: "json_schema",
      schema: { type: "object", properties: { company: { type: "string" } } }
    }
  }
})
// result.data.info.structured_output → validiertes JSON
```

---

## Relevanz für NanoClaw-Klon

### Korrektur zur früheren Analyse

Claude Code und OpenCode sind beide langlebige TUI/CLI-Prozesse — kein fundamentaler Unterschied im Lifecycle. Der echte Unterschied: **OpenCode hat ein offenes TypeScript SDK** (`@opencode-ai/sdk`) das programmatische Steuerung ermöglicht, während NanoClaw Claude Code über `--remote` und eine Browser-Session steuert.

### Der klare Integrationsweg

```
Container (Docker)
    ↓
createOpencode() — startet OpenCode-Server + Client
    ↓
client.session.create() — neue Session
    ↓
client.session.prompt() — User-Nachricht senden
    ↓
client.event.subscribe() — SSE-Stream für Antwort
    ↓
Output parsen → NanoClaw-Sentinels senden
```

**Vorteile:**
- `createOpencode()` startet Server und Client in einem Schritt — perfekt für Container
- `session.prompt({ noReply: true })` erlaubt Kontext-Injection (wie CLAUDE.md)
- SSE-Events sind direkter als NanoClaw's polling-basierter stdout-Ansatz
- `auth.set()` erlaubt dynamische API-Key-Übergabe (Credential-Proxy kompatibel)
- Multi-Provider von Anfang an möglich

**Herausforderungen:**
- Session-Persistenz: OpenCode's `sessions.db` muss per Volume gemountet werden
- NanoClaw's MessageStream-Konzept (Multi-Turn in einem Container) muss mit SSE nachgebaut werden
- IPC für Follow-up-Nachrichten: statt Filesystem-Polling → `session.prompt()` auf laufende Session
