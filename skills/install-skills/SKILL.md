---
name: install-skills
description: Search and install community skills from skills.sh using the Vercel skills CLI. Use when the user wants to find, install, list, or remove external/community skills. For creating custom skills from scratch, see the skill-creator skill instead.
---

# install-skills

Install community skills to extend your capabilities using the `npx skills` CLI.

For creating custom skills from scratch, use the `skill-creator` skill instead.

## Searching for Skills

Use `npx skills find` to search for skills by keyword:

```bash
npx skills find <query>
```

You can also browse the leaderboard at https://skills.sh to discover popular skills.

## Installing a Skill

### Group-local (default)

Always run the install command from `/workspace/project/` so that skills are installed into the group's project-local `.agents/skills/` directory:

```bash
cd /workspace/project && npx skills add <owner/repo> -a opencode -y
```

Examples:

```bash
cd /workspace/project && npx skills add vercel-labs/agent-skills -a opencode -y
cd /workspace/project && npx skills add vercel-labs/agent-skills --skill frontend-design -a opencode -y
```

### Global (admin only)

To make a community skill available to all groups, install it locally first, then publish it globally using the `publish_skill` MCP tool:

1. Install locally: `cd /workspace/project && npx skills add <owner/repo> -a opencode -y`
2. Read the installed skill files from `/workspace/data/project/.agents/skills/<name>/`
3. Use `publish_skill` to publish them globally
4. Optionally remove the local copy: `cd /workspace/project && npx skills remove <name> -a opencode -y`

## After Installation

Installed skills become active in the **next session**. Tell the user to send `/new` to start a fresh session and load the new skills.

## Listing Installed Skills

```bash
cd /workspace/project && npx skills list
```

## Removing a Skill

```bash
cd /workspace/project && npx skills remove <skill-name> -a opencode -y
```

## Important Notes

- Skills are installed **per group** by default — they only affect the current group's agent.
- Global skills (available to all groups) can be published by the admin using `publish_skill`.
- Always use the `-a opencode` flag to target the correct agent directory.
- Always use the `-y` flag to skip interactive prompts.
