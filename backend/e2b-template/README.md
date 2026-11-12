# kronyx-browser E2B template

Custom sandbox image that adds, on top of the stock E2B base:

- **Chromium + Playwright + browser-use** — powers the agent's `browser_use`
  tool (autonomous UI testing) and the post-run verify screenshot.
- **Qt/GUI system libs** (`libgl1`, `libegl1`, `xvfb`, …) — PyQt5/PySide
  imports work; run tests with `QT_QPA_PLATFORM=offscreen` (no X needed) or
  `xvfb-run <cmd>` for a real display.

## Build

```bash
npm i -g @e2b/cli        # or: brew install e2b
e2b auth login
cd backend/e2b-template
e2b template build       # prints a template name/id
```

Set the printed name in the Composer's **template** field (it lands on
`session.template` → `Sandbox.create(template)` — no code changes needed).

## Without a custom template

The stock template still works for non-GUI tasks. For PyQt5 you can install
deps per-sandbox (slow, ~1 min):

```bash
sudo apt-get update && sudo apt-get install -y libgl1 libegl1 libxkbcommon0 \
  libxkbcommon-x11-0 libdbus-1-3 libfontconfig1 libglib2.0-0 xvfb
QT_QPA_PLATFORM=offscreen python3 -c "from PyQt5.QtWidgets import QApplication"
```

`browser_use` reports a clear "not installed" error on sandboxes missing
browser tooling, and the verify screenshot step silently skips.
