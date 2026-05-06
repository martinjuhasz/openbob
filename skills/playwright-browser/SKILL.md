# playwright-browser

Browse the web using `playwright-cli`. Supports persistent browser profiles for authenticated sessions.

## Quick start (headless)

```bash
playwright-cli -s=<name> open <url> --persistent --profile=/workspace/data/project/.browser-profiles/<name>
playwright-cli -s=<name> snapshot -i       # Get interactive elements
playwright-cli -s=<name> click @e1         # Click element
playwright-cli -s=<name> fill @e2 "text"   # Fill input
playwright-cli -s=<name> screenshot        # Take screenshot
playwright-cli -s=<name> close             # Close browser (profile remains)
```

## Persistent profiles

Browser profiles (cookies, localStorage, sessions) are saved under `/workspace/data/project/.browser-profiles/<name>/` and persist across container restarts.

## VNC Browser Sessions (for manual login)

If a profile doesn't exist yet or the login has expired, use the MCP tools to let the user log in manually:

1. `vnc_browser_session_start` — opens a real browser with GUI, accessible via noVNC
2. User opens the provided URL, logs in, then confirms they're done
3. `vnc_browser_session_stop` — closes the VNC browser, profile is saved
4. Now use the profile headless with `playwright-cli` as shown above

Use `vnc_browser_session_status` to check active sessions and saved profiles.

## Important

- Only ONE VNC session can be active at a time (per group)
- Multiple profiles can be saved and used headless simultaneously
- Never use `playwright-cli` on a profile that has an active VNC session (lock conflict)
- If headless access fails with auth errors, suggest the user re-login via VNC
