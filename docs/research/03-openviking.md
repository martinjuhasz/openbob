# OpenViking - Detailanalyse

**Quelle:** https://openviking.ai / https://github.com/volcengine/OpenViking
**Analysiert am:** 2026-03-23
**Stars:** ~18.4k | **Forks:** ~1.3k
**Lizenz:** Open Source | **Maintainer:** ByteDance / Volcano Engine

---

## Was ist OpenViking?

OpenViking ist eine Open-Source **Context-Datenbank** speziell für AI-Agenten, entwickelt von ByteDance's Volcano Engine Team. Es löst das Problem der Context-Fragmentierung: Memory liegt im Code, Ressourcen in Vektor-Datenbanken, Skills sind überall verstreut — OpenViking vereint das alles in einem Filesystem-Paradigma.

**Benchmark:** Auf LoCoMo10 (1.540 Long-Range-Dialogue-Cases): **49% Verbesserung** über Baseline bei **83% weniger Token-Kosten**.

---

## Core-Konzept: Filesystem als Context-Metapher

Statt flat vector databases organisiert OpenViking alles als virtuelles Filesystem mit `viking://` URIs:

```
viking://
├── resources/              # Ressourcen: Docs, Code-Repos, Webseiten
│   └── my_project/
├── user/                   # User-Kontext: Präferenzen, Gewohnheiten
│   └── memories/
└── agent/                  # Agent-Kontext: Skills, Instructions, Task-Memories
    ├── skills/
    └── memories/
```

**Unified URI:** Jeder Context-Eintrag hat eine eindeutige `viking://` URI — egal wo er physisch gespeichert ist.

---

## Drei Context-Typen

| Typ | Zweck | Lifecycle |
|---|---|---|
| **Resource** | Wissen & Regeln (Docs, Code, FAQ) | Langfristig, relativ statisch |
| **Memory** | Agent-Kognition (User-Präferenzen, gelernte Erfahrungen) | Langfristig, dynamisch aktualisiert |
| **Skill** | Aufrufbare Fähigkeiten (Tools, MCP) | Langfristig, statisch |

---

## Drei Lade-Ebenen (L0/L1/L2)

Statt den gesamten Kontext auf einmal in den Prompt zu laden:

| Ebene | Name | Token-Limit | Zweck |
|---|---|---|---|
| **L0** | Abstract | ~100 Tokens | Vektor-Suche, schnelles Filtern |
| **L1** | Overview | ~2.000 Tokens | Reranking, Content-Navigation |
| **L2** | Detail | Unbegrenzt | Vollständiger Inhalt, On-Demand |

**Filesystem-Struktur pro Directory:**
```
viking://resources/my_project/
├── .abstract.md               # L0: Abstract
├── .overview.md               # L1: Overview
├── docs/
│   ├── .abstract.md
│   ├── .overview.md
│   └── api.md                 # L2: Vollinhalt
└── src/
```

**Vorteil:** Agent plant mit L0/L1 (günstig), holt L2 nur bei Bedarf → massive Token-Einsparung.

---

## Retrieval-Mechanismus: Directory Recursive Retrieval

Single-Vector-Retrieval scheitert bei komplexen Query-Intents. OpenViking's Ansatz:

1. **Intent-Analyse:** Query → mehrere Retrieval-Bedingungen
2. **Initial Positioning:** Vektor-Retrieval findet hoch-bewertete Directories
3. **Fine Exploration:** Sekundäres Retrieval innerhalb der Directories
4. **Recursive Descent:** Bei Subdirectories rekursiv wiederholen
5. **Result Aggregation:** Relevantesten Context zurückgeben

Hybrid aus **Vektor-Suche** + **deterministischem Filesystem-Traversal**.

---

## Memory Self-Iteration (Automatisches Memory-Management)

OpenViking hat eingebaute Memory-Iterations-Loops. Am Ende jeder Session:

1. System analysiert Task-Ausführung und User-Feedback asynchron
2. Extrahiert Long-Term-Memory automatisch
3. Updated User- und Agent-Memory-Directories

**6 Memory-Kategorien:**

| Kategorie | Owner | Beschreibung |
|---|---|---|
| `profile` | user | User-Basisinformationen |
| `preferences` | user | User-Präferenzen nach Thema |
| `entities` | user | Entity-Memories (Personen, Projekte) |
| `events` | user | Event-Records (Entscheidungen, Meilensteine) |
| `cases` | agent | Gelernte Fälle |
| `patterns` | agent | Gelernte Muster |

Agents werden mit der Zeit "schlauer" — Self-Evolution durch Interaktion.

---

## API / SDK

**Unix-ähnliche API:**
```python
client.find("user authentication")       # Semantische Suche
client.ls("viking://resources/")         # Directory-Listing
client.read("viking://resources/doc")    # Content lesen
client.abstract("viking://...")          # L0 Abstract holen
client.overview("viking://...")          # L1 Overview holen
```

**Python SDK:**
```bash
pip install openviking
```

**Rust CLI (optional):**
```bash
curl -fsSL https://raw.githubusercontent.com/volcengine/OpenViking/main/crates/ov_cli/install.sh | bash
```

---

## Tech Stack

| Bereich | Technologie |
|---|---|
| Primäre Sprache | Python (SDK + Server) |
| Performance-kritisch | Rust (CLI-Tools) |
| Filesystem | Go (AGFS - Agent File System) |
| Core-Extensions | C++ (GCC 9+ oder Clang 11+) |
| Anforderungen | Python 3.10+, Go 1.22+ |

---

## Unterstützte Model-Provider

**LLM-Provider:**
- Volcengine (Doubao-Modelle)
- OpenAI (GPT-4 Vision, etc.)
- LiteLLM (Anthropic, DeepSeek, Gemini, Qwen, vLLM, Ollama)

**Embedding-Provider:**
- Volcengine, OpenAI, Jina, Voyage, MiniMax, VikingDB, Gemini

**Config:** `~/.openviking/ov.conf`

---

## Deployment / Self-Hosting

- Docker (Dockerfile inklusive)
- Docker Compose
- Helm Charts (`deploy/helm`)
- Daten lokal im Workspace gespeichert

---

## MCP-Server-Integration

OpenViking unterstützt MCP (Model Context Protocol) als Skill-Typ — d.h. externe Tools können als Skills registriert werden, die Agents über OpenViking aufrufen können.

---

## Vergleich: OpenViking vs. NanoClaw Memory

| Merkmal | NanoClaw (aktuell) | OpenViking |
|---|---|---|
| Format | CLAUDE.md Files | `viking://` URI Virtual Filesystem |
| Retrieval | Statisch (alle Files geladen) | Semantisch + Hierarchisch (L0→L2) |
| Memory-Types | Undifferenziert | Resource / Memory / Skill |
| Auto-Distillation | Nein | Ja (Session-Ende → Long-Term Memory) |
| Token-Effizienz | Schlecht (alles wird geladen) | Sehr gut (L0/L1/L2 On-Demand) |
| Suchbarkeit | Nein | Ja (Vektor + Filesystem) |
| Self-Evolution | Nein | Ja |
| Setup-Komplexität | Minimal | Hoch (Python, Go, C++, Embedding-Provider) |

---

## Relevanz für NanoClaw-Klon

### Chancen
- Löst fundamentales Problem: NanoClaw's file-basiertes Memory skaliert nicht
- Token-Effizienz durch L0/L1/L2 spart erhebliche API-Kosten
- Self-evolving Memory ist ein echtes Differenzierungsmerkmal
- Open Source + Self-Hosting möglich
- Python-SDK leicht integrierbar

### Herausforderungen
- **Hohe Setup-Komplexität:** Python, Go, C++, Embedding-Provider nötig
- **ByteDance-Background:** Manche Nutzer könnten Datenschutzbedenken haben
- **Primär für OpenClaw (anderes Projekt)** designt, nicht spezifisch für NanoClaw
- **Embedding-Kosten:** Vektor-Suche braucht Embedding-API oder lokales Modell
- **Sprachbarriere:** Python/Go/Rust Stack vs. NanoClaw's reines TypeScript
- **Latenz:** Vektor-Suche + Hierarchical Retrieval adds overhead

### Integrationsoptionen

**Option A: Vollständige Integration**
- OpenViking ersetzt CLAUDE.md-System komplett
- Agent im Container nutzt OpenViking Python SDK
- Host managed OpenViking-Server als Sidecar
- Vorteil: Maximale Funktionalität
- Nachteil: Hohe Komplexität, fremder Stack

**Option B: Partial Integration (nur Memory)**
- OpenViking nur für Memory-Management (User + Agent Memory)
- CLAUDE.md bleibt für statischen Kontext (System-Prompts etc.)
- Vorteil: Nutzt stärkste Feature (Self-Evolution) ohne volle Komplexität
- Nachteil: Hybridansatz, zwei Systeme zu pflegen

**Option C: Später einbauen (gestaffelt)**
- Klon startet ohne OpenViking (wie NanoClaw aktuell)
- OpenViking als optionaler Skill/Plugin hinzufügbar
- Vorteil: Niedrige Einstiegshürde, inkrementelle Verbesserung
- Nachteil: Memory-Schwäche bleibt initial bestehen
