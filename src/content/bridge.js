// Bridge content script.
//
// The reused picker (webrobot-picker.js) only talks out via
//   send() -> window.parent.postMessage(payload, '*')
// and listens for inbound config via window 'message' events. In a content
// script the page IS the top window (window.parent === window), so those
// messages land on THIS window. We relay them to/from the extension's
// background (and thus the side-panel UI) over chrome.runtime.
//
// Inject ORDER matters: load bridge.js BEFORE webrobot-picker.js so the
// listeners are registered before the picker can emit anything.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  // Idempotent: re-injection on every pick must not stack duplicate relays.
  if (window.__wrBridgeInjected) return;
  window.__wrBridgeInjected = true;

  // picker -> background (only webrobot-* messages; skip what we delivered).
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.__wr_inbound) return;
    if (typeof d.type !== 'string' || d.type.indexOf('webrobot-') !== 0) return;
    try { api.runtime.sendMessage({ __wr_picker: true, payload: d }); } catch (_) {}
  });

  // background/side-panel -> picker (delivered onto this window for the picker's
  // own 'message' listener). __wr_inbound marks it so our listener above ignores it.
  api.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.__wr_to_picker) return;
    try { window.postMessage({ ...msg.payload, __wr_inbound: true }, '*'); } catch (_) {}
  });
})();
