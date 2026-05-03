---
name: install-skills
description: Search and install community skills from skills.sh using the Vercel skills CLI
---

# install-skills

Install community skills to extend your capabilities using the `npx skills` CLI.

## Searching for Skills

Use `npx skills find` to search for skills by keyword:

```bash
npx skills find <query>
```

You can also browse the leaderboard at https://skills.sh to discover popular skills.

## Installing a Skill

Always run the install command from `/workspace/project/` so that skills are installed into the group's project-local `.agents/skills/` directory:

```bash
cd /workspace/project && npx skills add <owner/repo> -a opencode -y
```

Examples:

```bash
cd /workspace/project && npx skills add vercel-labs/agent-skills -a opencode -y
cd /workspace/project && npx skills add vercel-labs/agent-skills --skill frontend-design -a opencode -y
```

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

- Skills are installed **per group** — they only affect the current group's agent.
- Global skills (available to all groups) can only be installed by an admin on the host machine.
- Always use the `-a opencode` flag to target the correct agent directory.
- Always use the `-y` flag to skip interactive prompts.
