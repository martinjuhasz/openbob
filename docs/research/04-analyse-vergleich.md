# Analyse & Vergleich — NanoClaw-Klon mit OpenCode + OpenViking

**Erstellt am:** 2026-03-23
**Zweck:** Grundlage für gemeinsame Konzeptentwicklung

---

## Das Ziel

Einen NanoClaw-Klon bauen der:
1. **OpenCode** statt Claude Code als Agent-Runner nutzt
2. **OpenViking** optional als Memory-Store einsetzt (noch zu entscheiden)
3. Den Rest der NanoClaw-Architektur beibehält oder verbessert

---

## Die Kern-Frage: Was muss sich ändern?

### Was NanoClaw aktuell macht (vereinfacht):

```
Messaging-Kanal (Telegram/WhatsApp)
        ↓
Host (Node.js) — routet Nachrichten
        ↓
Container (Docker) — ephemer, pro Nachricht
        ↓
Agent-Runner — nutzt @anthropic/claude-agent-sdk
        ↓
Claude Code (claude --remote) — Agent-Loop, Tools, Memory
        ↓
Antwort zurück via IPC → Host → Kanal
```

### Was der Klon machen soll:

```
Messaging-Kanal (Telegram/WhatsApp)
        ↓
Host (Node.js) — routet Nachrichten
        ↓
Container (Docker) — ephemer, pro Nachricht
        ↓
Agent-Runner — NEUE IMPLEMENTIERUNG
        ↓
OpenCode (opencode serve) — Agent-Loop, Tools, Memory
        ↓ (optional)
OpenViking — Context-Datenbank, semantisches Memory
        ↓
Antwort zurück via IPC → Host → Kanal
```

---

## Technische Herausforderungen im Detail

### Challenge 1: Claude Code vs. OpenCode — Korrigierte Einschätzung

Beide sind langlebige TUI/CLI-Prozesse — kein fundamentaler Lifecycle-Unterschied. Der echte Unterschied:

| | Claude Code (NanoClaw aktuell) | OpenCode |
|---|---|---|
| Steuerung | `claude --remote` → Browser-Session-URL | `@opencode-ai/sdk` → HTTP/SSE |
| API | Proprietär, geschlossen | Offen, TypeScript SDK |
| Provider | Nur Anthropic | 75+ Provider |
| Session-Persistenz | Claude Agent SDK `resume` | SQLite via Drizzle ORM |
| Kontext-Injection | CLAUDE.md Files (statisch) | `session.prompt({ noReply: true })` |

**Der klare Integrationsweg via SDK:**

```typescript
// Im Container-Runner statt @anthropic/claude-agent-sdk:
import { createOpencode } from "@opencode-ai/sdk"

const { client } = await createOpencode({ config: { model: "anthropic/..." } })
const session = await client.session.create({ body: { title: sessionId } })

// Kontext injizieren (wie CLAUDE.md)
await client.session.prompt({ path: { id: session.data.id }, body: { noReply: true, parts: [...] } })

// User-Nachricht → Agent-Loop
const result = await client.session.prompt({ path: { id: session.data.id }, body: { parts: [{ type: "text", text: userMessage }] } })

// Real-time Events via SSE
const events = await client.event.subscribe()
for await (const event of events.stream) { ... }
```

`createOpencode()` startet Server + Client in einem Schritt — perfekt für Container-Einsatz.

---

### Challenge 2: IPC-Protokoll

NanoClaw nutzt **Filesystem-IPC** (atomare Datei-Writes). OpenCode nutzt **HTTP/SSE**.

Für Option A (OpenCode im Container):
- Container startet OpenCode-Server lokal (z.B. Port 3000)
- Agent-Runner verbindet sich via SDK und schickt Prompt
- Antwort via SSE empfangen
- Nach Completion: OpenCode beenden, Container-Output via NanoClaw-Sentinels senden

---

### Challenge 3: Session-Persistenz

- NanoClaw: Session-ID in SQLite, `resume` via Claude Agent SDK
- OpenCode: Sessions in eigener `sessions.db` via Drizzle ORM

**Problem:** Pro Container läuft eine frische OpenCode-Instanz. Sessions würden nicht persistiert.

**Lösung:** OpenCode's `sessions.db` in persistentes Volume mounten (pro Gruppe wie NanoClaw's `.claude/`-Directories).

---

### Challenge 4: Credential/Security Model

NanoClaw's Credential-Proxy ist Claude-spezifisch (interceptet `api.anthropic.com`).

Für OpenCode mit Multi-Provider:
- Entweder: Nur Anthropic-Provider nutzen → Credential-Proxy bleibt
- Oder: Proxy auf alle konfigurierten Provider ausweiten (komplexer)
- Oder: Keys direkt in Container-Environment (Sicherheitsabstrich)

**Empfehlung:** Zunächst nur Anthropic-Provider, Proxy bleibt, einfachster Einstieg.

---

## OpenViking — Zu früh oder jetzt?

### Argumente für "Jetzt":
- Macht Memory von Anfang an richtig
- Kein späteres Refactoring des Memory-Systems
- Self-evolving Memory ist ein klares Differenzierungsmerkmal

### Argumente für "Später":
- Erheblich höhere Setup-Komplexität (Python + Go + C++ + Embedding-API)
- Blockt den Klon-Start
- Kann als optionaler Skill nachgerüstet werden
- NanoClaw funktioniert auch ohne — beweist, dass es nicht sofort nötig ist
- Erst testen ob OpenCode-Integration funktioniert, dann Memory verbessern

### Empfehlung (persönliche Einschätzung):
**Später** — aus zwei Gründen:
1. OpenViking hat noch eine hohe Betreiber-Komplexität (ByteDance-Stack)
2. Der kritische Engpass ist OpenCode als Agent-Runner, nicht das Memory-System

---

## Aufwandsschätzung (grob)

### Minimaler Klon (OpenCode als Agent-Runner, kein OpenViking):

| Komponente | Aufwand | Beschreibung |
|---|---|---|
| OpenCode im Container | Mittel | Dockerfile anpassen, opencode installieren |
| Neuer Agent-Runner | Hoch | Ersetzt claude-agent-sdk durch OpenCode |
| IPC-Anpassung | Mittel | HTTP/SSE statt stdio |
| Session-Mount | Gering | Volume für sessions.db |
| Credential-Anpassung | Gering | Proxy für Anthropic weiter nutzen |
| Tests | Mittel | End-to-End Tests |
| **Gesamt** | **Hoch** | Kernarchitektur-Änderung |

### Mit OpenViking zusätzlich:

| Komponente | Aufwand | Beschreibung |
|---|---|---|
| OpenViking-Server | Hoch | Setup, Embedding-Provider |
| Python SDK Integration | Mittel | Im Container oder als Sidecar |
| Memory-Migration | Mittel | CLAUDE.md → viking:// |
| **Zusatz** | **Sehr hoch** | Komplexes, fremder Stack |

---

## Zusammenfassung: Was wir für das Konzept entscheiden müssen

1. **OpenCode-Integrationsmodell:** Im Container (A) oder Host-seitig (B) oder SDK-direkt (C)?
2. **OpenViking:** Jetzt oder später?
3. **Provider-Strategy:** Nur Anthropic oder Multi-Provider von Anfang an?
4. **Fork-Basis:** Direkter Fork von NanoClaw oder Neubau?
5. **Name / Branding:** Eigener Name oder NanoClaw-Fork?
6. **Container-Modell:** Beibehalten (ephemer) oder persistenter Server?

---

## Offene Fragen / Research-Lücken

- Wie verhält sich OpenCode wenn es als "einmaliger" Prozess genutzt wird (kein Serve-Modus)?
- Gibt es ein `opencode run --prompt "..."` CLI-Interface analog zu `claude`?
- Wie ist die genaue Session-Resume-API von OpenCode?
- Gibt es bereits Community-Projekte die OpenCode ähnlich wie NanoClaw nutzen?
- Wie performt OpenViking auf einem normalen VPS (kein großer Server)?
