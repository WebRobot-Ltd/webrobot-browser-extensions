// API client for the side panel. All requests go through the background service
// worker (no page CORS; token kept in extension storage). Mirrors the role of
// DemoApp.vue's authenticatedDemoFetch.
const ext = globalThis.browser ?? globalThis.chrome;

const API_PREFIX = '/api/webrobot/api';

/** Low-level: ask the background to fetch `path` (relative to api.webrobot.eu). */
export async function apiFetch(path, init = {}) {
  const res = await ext.runtime.sendMessage({ __wr_cmd: 'api', path, init });
  if (!res) throw new Error('no response from background');
  if (res.error) throw new Error(res.error);
  return res; // { status, ok, body }
}

export async function get(path) {
  const r = await apiFetch(API_PREFIX + path, { method: 'GET' });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.body;
}

export async function post(path, payload) {
  const r = await apiFetch(API_PREFIX + path, { method: 'POST', body: JSON.stringify(payload || {}) });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
  return r.body;
}

// ── domain calls (subset for slice 1; grows as DemoApp.vue ports over) ──
export const catalogStages   = ()            => get('/demo/catalog/stages');
export const inferSegment     = (body)        => post('/demo/wizard/infer-segment', body);
export const inferFields      = (body)        => post('/demo/wizard/infer-fields', body);
export const inferBodySelector= (body)        => post('/demo/wizard/infer-body-selector', body);
export const executeDemo      = (name, body)  => post(`/demo/execute/${encodeURIComponent(name)}`, body);
export const executionStatus  = (id)          => get(`/demo/executions/${encodeURIComponent(id)}/status`);

// ── token (auth) helpers ──
export async function setToken(token) { await ext.storage.local.set({ token }); }
export async function getToken()      { const { token } = await ext.storage.local.get('token'); return token || ''; }

// ── picker control (via background → content script) ──
export async function activeTabId() {
  const tabs = await ext.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}
export async function startPicker(mode = 'selector-single') {
  const tabId = await activeTabId();
  if (tabId == null) throw new Error('no active tab');
  const r = await ext.runtime.sendMessage({ __wr_cmd: 'inject-picker', tabId });
  if (!r?.ok) throw new Error(r?.error || 'inject failed');
  await ext.runtime.sendMessage({ __wr_cmd: 'to-picker', tabId, payload: { type: 'webrobot-picker-mode', mode } });
  return tabId;
}
/** Subscribe to picker events forwarded by the background. Returns an unsubscribe fn. */
export function onPick(handler) {
  const listener = (msg) => { if (msg?.__wr_pick_event) handler(msg.payload, msg.tabId); };
  ext.runtime.onMessage.addListener(listener);
  return () => ext.runtime.onMessage.removeListener(listener);
}
