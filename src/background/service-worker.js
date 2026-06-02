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
  // Replay a recorded trace on the REAL page so the user SEES the actions
  // execute (click/input/hover/scroll/wait) — same trace fetch replays on
  // Camoufox at run time. Returns per-step results.
  if (msg.__wr_cmd === 'run-trace') {
    api.scripting.executeScript({
      target: { tabId: msg.tabId },
      args: [msg.actions || []],
      func: async (actions) => {
        try { window.__wrPickerOff = true } catch (_) {} // disable picker interception synchronously (same isolated world)
        const out = []
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        for (const a of actions) {
          try {
            if (a.type === 'Wait') { await sleep(a.ms || 1000); out.push('wait'); continue }
            if (a.type === 'Scroll') { window.scrollBy(0, Number(a.y || 600)); out.push('scroll'); await sleep(300); continue }
            const el = a.selector ? document.querySelector(a.selector) : null
            if (!el) { out.push('miss:' + (a.selector || a.type)); continue }
            el.scrollIntoView({ block: 'center' })
            if (a.type === 'Type') {
              el.focus(); el.value = a.text || ''
              el.dispatchEvent(new Event('input', { bubbles: true }))
              el.dispatchEvent(new Event('change', { bubbles: true }))
              out.push('type')
            } else if (a.type === 'Hover') {
              el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
              out.push('hover')
            } else { el.click(); out.push('click') }
            await sleep(500)
          } catch (e) { out.push('err:' + (e && e.message)) }
        }
        return out
      },
    }).then((r) => sendResponse({ ok: true, steps: (r && r[0] && r[0].result) || [] }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  // Highlight selector matches on the REAL page (any stage) + return match
  // counts, so the user SEES what each selector/segment/field captures.
  if (msg.__wr_cmd === 'highlight') {
    api.scripting.executeScript({
      target: { tabId: msg.tabId },
      args: [msg.items || [], msg.scope || null],
      func: (items, scopeSel) => {
        document.querySelectorAll('[data-wr-hl]').forEach(e => { e.style.outline = ''; e.removeAttribute('data-wr-hl') })
        const scope = scopeSel ? document.querySelector(scopeSel) : document
        const counts = []
        for (const it of items) {
          let n = 0
          try {
            const root = (it.relativeToScope && scope !== document) ? scope : document
            const els = (root || document).querySelectorAll(it.selector)
            n = els.length
            els.forEach(e => { e.setAttribute('data-wr-hl', '1'); e.style.outline = `2px solid ${it.color || '#4f46e5'}`; e.style.outlineOffset = '1px' })
            if (els[0]) els[0].scrollIntoView({ block: 'center' })
          } catch (_) {}
          counts.push({ selector: it.selector, label: it.label || '', count: n })
        }
        setTimeout(() => { document.querySelectorAll('[data-wr-hl]').forEach(e => { e.style.outline = ''; e.removeAttribute('data-wr-hl') }) }, 5000)
        return counts
      },
    }).then((r) => sendResponse({ ok: true, counts: (r && r[0] && r[0].result) || [] }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
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

// Demo auto-auth: the /demo/* endpoints are public but the portal still
// attaches an anonymous demo JWT (org attribution). We replicate it — log in
// to Strapi with the same demo creds the VitePress demo uses (already public
// in that bundle), cache the JWT, refresh on 401. No user-entered key needed.
const STRAPI_URL = 'https://strapi.webrobot.eu';
const DEMO_EMAIL = 'demo@webrobot.eu';
const DEMO_PASSWORD = 'demo2026';

async function demoToken(force) {
  if (!force) { const { demo_jwt } = await api.storage.local.get('demo_jwt'); if (demo_jwt) return demo_jwt; }
  try {
    const r = await fetch(STRAPI_URL + '/api/auth/local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: DEMO_EMAIL, password: DEMO_PASSWORD }),
    });
    const j = await r.json().catch(() => ({}));
    const t = j.jwt || (j.data && j.data.jwt) || '';
    if (t) await api.storage.local.set({ demo_jwt: t });
    return t;
  } catch (_) { return ''; }
}

// Thin proxy for the WebRobot REST API. Auth precedence: user-supplied token
// (advanced) → auto demo JWT. On 401 with the demo token, refresh once.
async function apiFetch(path, init = {}) {
  const { token } = await api.storage.local.get('token'); // optional override
  async function once(bearer) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, init.headers || {},
      bearer ? { Authorization: 'Bearer ' + bearer } : {});
    const res = await fetch(API_BASE + path, Object.assign({}, init, { headers }));
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch (_) { body = text; }
    return { status: res.status, ok: res.ok, body };
  }
  let bearer = token || await demoToken(false);
  let r = await once(bearer);
  if (r.status === 401 && !token) { bearer = await demoToken(true); r = await once(bearer); }
  return r;
}
