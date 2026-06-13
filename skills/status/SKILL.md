---
name: status
description: Gather and report system status including registered groups, scheduled tasks, and service health. Use when the user asks for system status, health checks, or wants an overview of running services.
---

# status

When asked for system status, gather and report:

- Registered groups/channels — use the `list_groups` MCP tool
- Scheduled tasks and their status — use the `list_tasks` MCP tool
- OpenViking health — run `curl -s http://openviking:1933/health` (may fail if OpenViking is not configured)

Present the results in a concise, readable summary.
