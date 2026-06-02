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

// ── domain calls (ported from DemoApp.vue, same endpoints) ──
export const catalogStages    = ()            => get('/demo/catalog/stages');
export const listPipelines     = ()            => get('/demo/list');   // → { demos:[{pipeline_name, pipeline_yaml, ...}] }
export const inferSegment      = (body)        => post('/demo/wizard/infer-segment', body);
export const inferSelector     = (body)        => post('/demo/wizard/infer-selector', body);
export const inferFields       = (body)        => post('/demo/wizard/infer-fields', body);
export const inferBodySelector = (body)        => post('/demo/wizard/infer-body-selector', body);
export const inferOddsStructure= (body)        => post('/demo/wizard/infer-odds-structure', body);
export const relaxSelectors    = (body)        => post('/demo/wizard/relax-selectors', body);
export const suggestFieldNames = (body)        => post('/demo/wizard/suggest-field-names', body);
export const validatePipeline  = (body)        => post('/demo/wizard/validate', body);
// Run: save the built YAML + execute in one call (Save & Run), then poll.
export const saveGeneratedPipeline = (body)    => post('/demo/save-generated-pipeline', body);
export const executeDemo       = (name, body)  => post(`/demo/execute/${encodeURIComponent(name)}`, body);
// Run an already-saved pipeline by name → { execution_id, output_dataset_id }.
export const executeByName     = (name, params) => post(`/demo/execute/${encodeURIComponent(name)}`, { parameters: params || { limit: 10 } });
// Upload a CSV as the input dataset (multipart via background) → { datasetId }.
export async function uploadCsv(name, csv, filename) {
  const r = await ext.runtime.sendMessage({ __wr_cmd: 'upload-csv', name, csv, filename });
  if (!r) throw new Error('no response'); if (r.error) throw new Error(r.error);
  if (!r.ok) throw new Error(`upload → ${r.status}`); return r.body;
}
export const executionStatus   = (id)          => get(`/demo/executions/${encodeURIComponent(id)}/status`);
export const executionLogs     = (id)          => get(`/demo/executions/${encodeURIComponent(id)}/logs`);
export const executionOutput   = (id, datasetId, limit = 10) =>
  get(`/demo/executions/${encodeURIComponent(id)}/output?limit=${limit}` +
      (datasetId != null && datasetId !== '' ? `&datasetId=${encodeURIComponent(datasetId)}` : ''));

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
/** Active tab URL (for fetch/visit "use current URL"). */
export async function currentUrl() {
  const r = await ext.runtime.sendMessage({ __wr_cmd: 'current-url' });
  return (r && r.url) || '';
}
/** Mark/unmark a tab as the active recording session (background re-injects the
 *  picker on navigation so multi-page traces keep recording). */
export async function recStart(tabId) { const id = tabId ?? await activeTabId(); await ext.runtime.sendMessage({ __wr_cmd: 'rec-start', tabId: id }) }
export async function recStop() { await ext.runtime.sendMessage({ __wr_cmd: 'rec-stop' }) }
/** Replay a recorded trace on the REAL page (local — no Camoufox). */
export async function runTrace(actions) {
  const tabId = await activeTabId()
  const r = await ext.runtime.sendMessage({ __wr_cmd: 'run-trace', tabId, actions })
  return r || {}
}
/** Highlight selector matches on the REAL page + get counts (local, any stage). */
export async function highlight(items, scope) {
  const tabId = await activeTabId()
  const r = await ext.runtime.sendMessage({ __wr_cmd: 'highlight', tabId, items, scope: scope || null })
  return (r && r.counts) || []
}
/** Live page HTML (whole page, or one selector's outerHTML) for AI inference. */
export async function pageHtml(selector) {
  const tabId = await activeTabId();
  const r = await ext.runtime.sendMessage({ __wr_cmd: 'page-html', tabId, selector: selector || null });
  return (r && r.html) || '';
}
/** Send a message INTO the picker (highlight, mode, generalize-result, …). */
export async function sendToPicker(tabId, payload) {
  const id = tabId ?? await activeTabId();
  if (id == null) return;
  await ext.runtime.sendMessage({ __wr_cmd: 'to-picker', tabId: id, payload });
}
/** Subscribe to picker events forwarded by the background. Returns an unsubscribe fn. */
export function onPick(handler) {
  const listener = (msg) => { if (msg?.__wr_pick_event) handler(msg.payload, msg.tabId); };
  ext.runtime.onMessage.addListener(listener);
  return () => ext.runtime.onMessage.removeListener(listener);
}
