// Side-panel UI (skeleton). This is where DemoApp.vue gets ported: pipeline
// designer + variables + RUN + output. For now it just: injects the picker on
// the active tab, shows incoming picks, and demonstrates the API proxy.
const api = globalThis.browser ?? globalThis.chrome;

const picksEl = document.getElementById('picks');

async function activeTabId() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

// "Start picking" → inject picker into the active tab, then put it in
// single-selector mode (the picker's existing protocol).
document.getElementById('start').addEventListener('click', async () => {
  const tabId = await activeTabId();
  if (tabId == null) return;
  const r = await api.runtime.sendMessage({ __wr_cmd: 'inject-picker', tabId });
  if (!r?.ok) { addNote('Inject failed: ' + (r?.error || '?')); return; }
  // send config to the picker (same messages DemoApp.vue's host sends)
  api.runtime.sendMessage({ __wr_cmd: 'to-picker', tabId, payload: { type: 'webrobot-picker-mode', mode: 'selector-single' } });
  addNote('Picker active — click an element on the page.');
});

// Receive picks forwarded by the background.
api.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.__wr_pick_event) return;
  renderPick(msg.payload);
});

function renderPick(p) {
  const div = document.createElement('div');
  div.className = 'pick';
  div.innerHTML = `<div><strong>${escapeHtml(p.type || 'pick')}</strong></div>` +
    (p.selector ? `<code>${escapeHtml(p.selector)}</code>` : '') +
    (p.sampleText ? `<div class="muted">${escapeHtml(String(p.sampleText).slice(0, 120))}</div>` : '');
  picksEl.prepend(div);
}

function addNote(t) {
  const div = document.createElement('div');
  div.className = 'muted';
  div.textContent = t;
  picksEl.prepend(div);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Example of an API call through the background (no page CORS):
// const res = await api.runtime.sendMessage({ __wr_cmd: 'api',
//   path: '/api/webrobot/api/demo/catalog/stages', init: { method: 'GET' } });
