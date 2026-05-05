---
name: skill-creator
description: Create new custom skills for openbob, modify and improve existing skills. Use this skill whenever the user wants to create a skill from scratch, edit an existing skill, or asks about how skills work in openbob. Also use when someone says "turn this into a skill", "make a skill for X", "can you automate this as a skill", or discusses skill structure, SKILL.md files, or skill publishing.
---

# Skill Creator

A skill for creating new openbob skills and improving existing ones.

## How Skills Work in openbob

Skills are instruction sets that extend what the agent can do. Each skill is a folder with a `SKILL.md` file (and optional resources). The agent reads these instructions and follows them when a matching task comes up.

There are two scopes:

- **Group-local skills** live in `/workspace/data/project/.agents/skills/<name>/` and are only available to the current group's agent.
- **Global skills** live in `/workspace/skills/<name>/` and are available to all groups. Only the admin (main group) can publish global skills.

Skills are loaded when a session starts. After creating or modifying a skill, the user needs to start a new session (`/new`) for changes to take effect.

For installing pre-made community skills from external sources, see the `install-skills` skill instead.

## Creating a Skill

### 1. Understand the Intent

Start by understanding what the user wants. If the conversation already contains a workflow they want to capture ("turn this into a skill"), extract the key details from the conversation history first.

Figure out:
- What should this skill enable the agent to do?
- When should it trigger? (what user messages or contexts)
- What's the expected output format?
- Should it be group-local or global?

### 2. Write the SKILL.md

Every skill needs a `SKILL.md` with YAML frontmatter and markdown instructions.

#### Structure

```
my-skill/
├── SKILL.md          (required)
├── references/       (optional — docs loaded as needed)
├── scripts/          (optional — executable helper scripts)
└── assets/           (optional — templates, icons, etc.)
```

#### Frontmatter

The frontmatter is the primary triggering mechanism. The `description` field determines when the agent decides to use this skill.

```yaml
---
name: my-skill
description: What this skill does and when to use it. Be specific about trigger contexts — include the kinds of user messages that should activate this skill.
---
```

Make descriptions slightly "pushy" to ensure the skill triggers reliably. Instead of "A skill for generating reports", write "Generate reports from data. Use whenever the user asks for reports, summaries, data analysis, CSV processing, or mentions wanting to visualize or understand their data."

#### Body

The body contains the actual instructions the agent will follow. Keep it under 500 lines. If you need more, use reference files in a `references/` subdirectory and point to them from the main SKILL.md.

#### Writing Tips

- Use imperative form ("Do X", not "You should do X")
- Explain the *why* behind important instructions — the agent is smart enough to generalize from reasoning, not just follow rules
- Include examples where they help clarify expected behavior
- Avoid rigid ALL-CAPS rules where possible — explain the reasoning instead
- If the skill supports multiple domains/frameworks, organize references by variant so the agent only loads what's relevant
- Keep it lean — remove instructions that don't pull their weight

#### Example

```yaml
---
name: meeting-notes
description: Create structured meeting notes from voice messages or text. Use whenever the user sends meeting content, voice recordings of meetings, or asks to summarize a discussion or call.
---
```

```markdown
# Meeting Notes

Extract and structure meeting notes from the provided content.

## Output Format

Use this template:
• Date: [date]
• Participants: [names if mentioned]
• Key Points:
  - [point 1]
  - [point 2]
• Action Items:
  - [ ] [task] — [owner if mentioned]
• Decisions:
  - [decision 1]

If the input is a voice transcription, clean up filler words and false starts.
Send the formatted notes back to the user via send_message.
```

### 3. Save the Skill

#### Group-local (any group)

Write the files directly to the filesystem:

```
/workspace/data/project/.agents/skills/<name>/SKILL.md
```

Create subdirectories as needed for references, scripts, or assets.

#### Global (admin only)

Use the `publish_skill` MCP tool to publish the skill to all groups:

```
publish_skill(
  name: "my-skill",
  files: [
    { path: "SKILL.md", content: "---\nname: my-skill\n..." }
  ]
)
```

The tool handles writing to the shared `/workspace/skills/` directory. Include all files (SKILL.md, references, scripts, etc.) in the `files` array.

### 4. Activate

Tell the user to send `/new` to start a fresh session. The new skill will be loaded automatically.

## Modifying an Existing Skill

1. Read the current SKILL.md from its location (check both `/workspace/skills/<name>/` for global and `/workspace/data/project/.agents/skills/<name>/` for local skills)
2. Make the requested changes
3. Save it back — for global skills use `publish_skill`, for local skills write directly
4. Remind the user to start a new session (`/new`)

## Skill Security

Skills must not contain malware, exploit code, or anything that could compromise system security. Don't create skills designed to facilitate unauthorized access, data exfiltration, or other malicious activities. A skill's behavior should not surprise the user if described.
