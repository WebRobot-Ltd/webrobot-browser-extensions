// Background service worker (Chrome) / background script (Firefox).
// Roles:
//   1. messaging hub: content-script picker  <->  side-panel UI
//   2. WebRobot API client (calls api.webrobot.eu from here = no page CORS,
//      token stays in extension storage)
//   3. on-demand injection of the picker into the active tab
const api = globalThis.browser ?? globalThis.chrome;
const API_BASE = 'https://api.webrobot.eu';

// Chrome: open the side panel when the toolbar icon is clicked.
try { api.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }); } catch (_) {}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  // picker event from a content script -> broadcast to the side panel
  if (msg.__wr_picker) {
    api.runtime.sendMessage({ __wr_pick_event: true, payload: msg.payload, tabId: sender?.tab?.id })
      .catch(() => {});
    return;
  }

  // side panel commands
  if (msg.__wr_cmd === 'inject-picker') {
    injectPicker(msg.tabId).then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }
  if (msg.__wr_cmd === 'to-picker') {
    api.tabs.sendMessage(msg.tabId, { __wr_to_picker: true, payload: msg.payload }).catch(() => {});
    return;
  }
  if (msg.__wr_cmd === 'api') {
    apiFetch(msg.path, msg.init).then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
    return true; // async
  }
  // Current active-tab URL (fetch/visit "use current URL").
  if (msg.__wr_cmd === 'current-url') {
    api.tabs.query({ active: true, currentWindow: true })
      .then((t) => sendResponse({ url: t[0]?.url || '', title: t[0]?.title || '' }))
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  // Grab the live page HTML (whole page, or one selector's outerHTML) for AI
  // Magic — uses the user's REAL rendered page (no Camoufox needed for picking).
  if (msg.__wr_cmd === 'page-html') {
    api.scripting.executeScript({
      target: { tabId: msg.tabId },
      args: [msg.selector || null],
      func: (sel) => {
        try {
          if (sel) { const el = document.querySelector(sel); return el ? el.outerHTML : ''; }
          return document.documentElement.outerHTML;
        } catch (_) { return ''; }
      },
    }).then((r) => sendResponse({ html: (r && r[0] && r[0].result) || '' }))
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
});

async function injectPicker(tabId) {
  // bridge BEFORE picker (see bridge.js).
  await api.scripting.executeScript({
    target: { tabId },
    files: ['src/content/bridge.js', 'src/content/webrobot-picker.js'],
  });
}

// Thin proxy for the WebRobot REST API (infer-segment/fields/selector,
// apply-variables, execute, executions/{id}/status|logs|output, save, ...).
async function apiFetch(path, init = {}) {
  const { token } = await api.storage.local.get('token');
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    init.headers || {},
    token ? { Authorization: 'Bearer ' + token } : {}
  );
  const res = await fetch(API_BASE + path, Object.assign({}, init, { headers }));
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch (_) { body = text; }
  return { status: res.status, ok: res.ok, body };
}
