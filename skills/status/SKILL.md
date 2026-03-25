# status

When asked for system status, report:
- Running Docker containers (yetaclaw-host, openviking)
- OpenViking health (GET http://openviking:1933/health)
- Active sessions and scheduled tasks
- Registered groups/channels

Use `docker ps` and curl to gather this information.
