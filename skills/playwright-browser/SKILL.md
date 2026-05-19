# playwright-browser

Browse the web using the Playwright MCP browser tools connected to a **CloakBrowser-Manager** stealth browser profile via CDP (Chrome DevTools Protocol).

## How it works

You are NOT running a local headless Chromium. Your Playwright tools connect via CDP to a remote browser instance managed by CloakBrowser-Manager. This browser:

- Runs in **headed mode** (has a visible GUI accessible via noVNC)
- Uses a **persistent profile** with cookies, localStorage, and sessions that survive restarts
- Has **anti-bot/fingerprint protection** (stealth browser, not a standard Chromium)
- Is shared between you and the user — the user can see and interact with the same browser session via the noVNC web UI at any time

## User interaction

The user can open the CloakBrowser-Manager web UI and interact with your browser session simultaneously:
- They can log into sites manually (2FA, captchas)
- They can see what you're doing in real-time
- Changes they make (clicking, typing) are immediately visible to you
- You do NOT need to stop or restart anything — noVNC and your CDP connection work in parallel on the same browser

When the user says they've done something in the browser (e.g. "I logged in"), use any browser tool to inspect the current page state.

## Available tools

When browser is enabled for your group, these MCP tools are available:

- `browser_navigate` — Navigate to a URL
- `browser_snapshot` — Get a text snapshot of the page (preferred over screenshot)
- `browser_click` — Click an element
- `browser_type` — Type text into an element
- `browser_fill_form` — Fill multiple form fields
- `browser_select_option` — Select dropdown option
- `browser_hover` — Hover over an element
- `browser_press_key` — Press a keyboard key
- `browser_take_screenshot` — Take a screenshot
- `browser_tabs` — List, create, close, or select tabs
- `browser_close` — Close the current page
- `browser_wait_for` — Wait for text to appear/disappear

## Workflow

1. Use `browser_navigate` to open a URL
2. Use `browser_snapshot` to understand the page structure
3. Interact with elements using `browser_click`, `browser_type`, etc.
4. Use `browser_take_screenshot` to capture visual state

The browser connects automatically on your first tool call — no setup needed.

## Manual login by user (noVNC)

If the user needs to log into a website manually (e.g. for 2FA, captchas):

1. Tell the user to open the CloakBrowser-Manager web UI
2. They can see the browser profile and interact with it via the built-in noVNC viewer
3. noVNC and your CDP connection run in parallel — no need to stop anything
4. After the user logs in, you can continue using the browser tools with the authenticated session

## When to use the browser (instead of WebFetch/Exa)

**Always use browser tools when:**
- The user explicitly says "im Browser", "browse", "surf", or "öffne"
- You need to interact with a page (click, fill forms, login, scroll)
- The site requires JavaScript rendering to show content
- You need to take a visual screenshot of a page
- You are working with an authenticated session (cookies from previous login)
- The site blocks bots/scrapers (use the stealth browser profile)

**Use SearXNG/WebFetch when:**
- You only need to read static text content from a URL
- You're doing a quick web search for information
- No interaction or authentication is needed

**When in doubt and browser is enabled, prefer browser tools.**

## Important

- The browser profile persists cookies and sessions across container restarts
- noVNC and headless CDP access work simultaneously on the same profile
- If browser tools are not available, browser is not enabled for your group
