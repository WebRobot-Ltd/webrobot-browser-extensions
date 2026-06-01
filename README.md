# WebRobot Browser Extensions

Browser extension (Chrome/Edge + Firefox, Manifest V3) that lets you **pick
selectors directly on the real page** and build WebRobot ETL pipelines — no
Camoufox mirror / proxy needed for the picking phase.

## Why a browser extension

A content script runs **inside the real page** the user is browsing, so it
sidesteps the walls the server-side mirror exists to solve:

| Wall (Camoufox mirror) | Browser extension |
|---|---|
| X-Frame-Options / CSP frame-ancestors | n/a — we inject into the top-level page, not an iframe |
| CORS on assets | n/a — the page loads its own assets natively |
| Anti-bot (Cloudflare/Zephr/captcha) | already passed — it's the user's real session |
| SPA rendering | already rendered — the browser ran the JS |
| Login / paywall | the user is logged in in their own session |

Camoufox stays the **runtime** engine (distributed extraction on Spark + HITL
captcha during execution) — it is **not** used for picking.

> Caveat: the picker runs on the user's browser DOM; extraction runs on
> Camoufox. A/B tests / personalization can differ slightly — mitigated by the
> LLM selector generalization (`inferSegmentSelector` / AI-generalize).

## Architecture

```
 ┌─────────────── target page (real tab) ───────────────┐
 │  content scripts (injected on demand):                │
 │    • webrobot-picker.js  ← reused verbatim from the   │
 │       backend (demo-wizard-picker.js, 1845 lines)     │
 │    • bridge.js           ← translates the picker's    │
 │       window.postMessage  ⇄  chrome.runtime messaging │
 └───────────────────────────┬───────────────────────────┘
                             │ chrome.runtime
 ┌───────────────────────────┴───────────────────────────┐
 │  background service worker  (messaging hub +           │
 │  calls to api.webrobot.eu: infer-segment/fields/...,   │
 │  save/execute pipeline)                                │
 └───────────────────────────┬───────────────────────────┘
                             │ chrome.runtime
 ┌───────────────────────────┴───────────────────────────┐
 │  side panel (Chrome) / sidebar (Firefox)               │
 │  = THE WHOLE APP UI (port of DemoApp.vue):             │
 │    • pipeline designer (stage palette, editor,         │
 │      field/selector binding, variables, AI-infer)      │
 │    • RUN: submit → poll status/logs → output table     │
 │    • saved pipelines, datasets, preview                │
 └────────────────────────────────────────────────────────┘
```

The picker (content script) is just the **selector input**. Everything
else — composing the pipeline AND running it — lives in the side panel.

## Pipeline designer + run flow

The extension is the full designer, not just a picker:

1. **Design** — user picks elements on the page (content script) → selectors
   flow to the side panel; user adds stages, binds fields, sets variables. The
   side panel builds `pipeline_yaml` (reusing DemoApp.vue's logic).
2. **Run** — "Run" → background `POST /demo/execute` (or generate-pipeline +
   execute) → backend submits the job to **Camoufox/Spark** (runtime engine).
3. **Monitor** — background polls `/executions/{id}/status` + `/logs` → side
   panel shows progress (and surfaces HITL captcha links if the runtime blocks).
4. **Output** — on completion `/executions/{id}/output` → side panel renders the
   result table; pipeline can be saved (`/demo/save-generated-pipeline`).

So: **picking** happens locally in the browser (no Camoufox), **running**
happens on the backend (Camoufox/Spark) — the side panel orchestrates both via
the background API client. All of this already exists in `DemoApp.vue`; the port
swaps `authenticatedDemoFetch` → background fetch and the mirror iframe → the
content-script picker.

**Picker reuse trick:** `webrobot-picker.js` only talks out via
`send() → window.parent.postMessage`. In a content script (top page)
`window.parent === window`, so its messages land on the same window where
`bridge.js` listens and forwards them to `chrome.runtime`. Inbound config
(`webrobot-picker-mode`, `webrobot-generalize-result`, …) is delivered back via
`window.postMessage`. So the picker is reused **almost unchanged**.

## Layout

```
src/
  content/
    webrobot-picker.js   # copied from backend demo-wizard-picker.js (the picker)
    bridge.js            # window.postMessage ⇄ chrome.runtime bridge
  background/
    service-worker.js    # messaging hub + WebRobot API client
  sidepanel/
    sidepanel.html       # wizard UI shell
    sidepanel.js
manifest.chrome.json     # Chrome/Edge (side_panel, service_worker)
manifest.firefox.json    # Firefox (sidebar_action, browser_specific_settings)
```

## Build / load (skeleton)

Chrome/Edge:
1. `npm run build:chrome` → `dist/chrome/`
2. `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`

Firefox:
1. `npm run build:firefox` → `dist/firefox/`
2. `about:debugging` → This Firefox → Load Temporary Add-on → `dist/firefox/manifest.json`

(For now the build just copies `src/` + the right manifest + the polyfill into
`dist/<browser>/`. See `package.json`.)

## TODO

- [ ] Port `DemoApp.vue` into the side panel (stage editor + AI-infer + variables).
- [ ] Wire the background API client to `api.webrobot.eu` (auth token in `storage`).
- [ ] Re-inject content scripts on navigation to record multi-page traces.
- [ ] Map the picker's existing postMessage protocol to the side-panel UI.
- [ ] Icons.
