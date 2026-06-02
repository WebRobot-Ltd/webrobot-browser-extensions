/*
 * WebRobot wizard picker — injected by DemoWizardProxy into proxied
 * pages. Two modes:
 *
 *   1. SELECTOR mode (single | list)
 *      User hovers, clicks ONCE → we compute a CSS selector for that
 *      element and post it back to the parent. preventDefault on the
 *      click so the page does not navigate.
 *
 *   2. ACTION RECORDING mode
 *      User interacts normally. We OBSERVE clicks, typing, scrolling,
 *      and accumulate a list of standard WebRobot actions (Click(sel),
 *      Type(sel, text), Wait(ms), ScrollTo(sel)). preventDefault is
 *      NOT applied — the page works as usual until the user stops
 *      recording. Use case: build the `trace` of a fetch/visit stage
 *      visually instead of writing it by hand.
 *
 * Mode is controlled by the parent via postMessage; default is
 * selector-single.
 *
 * Parent ↔ iframe protocol
 * ───────────────────────
 *  parent → iframe :  { type: 'webrobot-picker-mode',
 *                        mode: 'selector-single' | 'selector-list' | 'action-record' }
 *  parent → iframe :  { type: 'webrobot-picker-stop-recording' }
 *
 *  iframe → parent :  { type: 'webrobot-picker-ready' }
 *  iframe → parent :  { type: 'webrobot-pick-selector',
 *                        selector, mode, matches, sampleText, sampleHtml }
 *  iframe → parent :  { type: 'webrobot-pick-actions', actions: [...] }
 *  iframe → parent :  { type: 'webrobot-picker-cancel' }       (ESC)
 *  iframe → parent :  { type: 'webrobot-picker-navigation', url } (action mode only)
 */
(function () {
  'use strict';

  var STYLE_HOVER  = '2px solid #2196f3';
  var STYLE_PICKED = '2px solid #43a047';
  // Used in selector-list / selector-single mode to outline OTHER
  // matches besides the clicked one — softer than STYLE_PICKED so the
  // user still sees which row they clicked. Background tint helps the
  // overall row distribution visible at a glance (especially for
  // flatSelect segment confirmation).
  var STYLE_LIST_MATCH = '2px dashed #43a047';
  var STYLE_LIST_MATCH_BG = 'rgba(67,160,71,0.10)';
  // Storage for the list-match outlines so we can clear them on the
  // next click (or when leaving selector-list mode). Same idea as
  // prevOutlines / multiFields but scoped to the soft-match layer.
  var listMatchNodes = [];
  function clearListMatchHighlights() {
    listMatchNodes.forEach(function (n) {
      try { n.style.outline = ''; n.style.background = ''; } catch (_) {}
    });
    listMatchNodes = [];
  }
  var prevOutlines = new WeakMap();
  var hovered = null;
  var pickedNode = null;

  var mode = 'selector-single';   // see protocol above
  // EXTENSION DIVERGENCE: on the REAL page the picker must YIELD when idle —
  // otherwise its capture-phase listeners block every <a> click forever (fine
  // in the Camoufox mirror, broken on the live tab: kills navigation + Replay).
  // The side panel sends {mode:'off'} to deactivate; any real mode reactivates.
  var pickerActive = true;
  // Link-following intent: set by the host for explore / join / visitExplore
  // stages (which FOLLOW a link). When true, a pick climbs from the clicked
  // element to its nearest <a href> ancestor before computing the selector —
  // otherwise picking the text <span> inside the link yields a selector with
  // no href, and the runtime's Visit('A.href) gets N/A → no navigation. Row
  // stages (flatSelect) leave this false so the row element is picked as-is.
  var linkMode = false;
  // When non-null, the session is gated by a captcha / WAF challenge.
  // Picker click/typing capture is suspended (user must interact with
  // the page natively to solve it) and a red banner offers Resume.
  var blockInfo = null;
  var actions = [];                // ACTION mode buffer
  var lastInputTime = 0;
  var lastInputTarget = null;
  // MULTI-FIELD mode state.
  var multiFields = [];            // [{selector, sampleText, color, label?}]
  // Optional container selector — when set, multi-field clicks are
  // constrained to descendants of one of the matched containers and
  // their selectors are computed RELATIVE to the container (so they
  // can be applied inside a flatSelect's per-row context at runtime).
  var multiContainerSelector = null;
  var multiPalette = ['#10b981','#3b82f6','#f59e0b','#ec4899','#8b5cf6','#ef4444','#14b8a6','#eab308'];
  // MULTI-SAMPLE mode: build a generic selector from N example clicks of
  // the same repeating element (used to pick "next-page link", "product
  // card link", etc. — the selector arg of explore/visitExplore/wgetExplore).
  var multiSampleNodes = [];        // [Element] — the clicked seeds
  var multiSampleSelector = null;   // last computed { selector, matches }
  var lastGeneralizeSeed = null;    // seed pending an AI-generalize reply
  var multiSampleStyleEl = null;    // injected <style> for highlight classes

  // ── ROW-LCA mode: define a row that spans two separate parts (e.g. the
  //    avatar block + the comment body) by clicking BOTH; we take their lowest
  //    common ancestor as the repeating row container. ──
  var lcaFirst = null;              // first clicked element (awaiting the second)
  var lcaHighlighted = [];          // temp highlight nodes to clear on reset
  // ANTI-BOT-RECORD mode: when toggled, action-record captures EVERY raw
  // mouse/key/wheel/scroll event with high-resolution timestamps so the
  // executor can replay them pixel-perfect via page.mouse.move/down/up +
  // keyboard.down/up. Required for Walmart / Datadome / PerimeterX-class
  // anti-bot that fingerprints mouse trajectory + hold duration + jitter.
  // Auto-enabled by the periodic captcha detector (see CAPTCHA_DETECT_JS
  // below); also user-toggleable via parent UI postMessage.
  var antiBotMode      = false;
  var antiBotStartTs   = 0;       // performance.now() when mode flipped on
  var antiBotLastMove  = 0;       // throttle for mousemove buffering
  var antiBotDetectInterval = null;

  // ── 1. Banner ─────────────────────────────────────────────────────
  var banner = document.createElement('div');
  banner.id = '__webrobot_picker_banner';
  banner.style.cssText = [
    'position:fixed','top:0','left:0','right:0','z-index:2147483647',
    'background:linear-gradient(90deg,#667eea,#764ba2)',
    'color:white','font-family:system-ui,-apple-system,sans-serif',
    'font-size:13px','padding:8px 14px','box-shadow:0 2px 6px rgba(0,0,0,0.25)',
    'display:flex','gap:14px','align-items:center','justify-content:space-between'
  ].join(';');
  var bannerText = document.createElement('span');
  var bannerMode = document.createElement('span');
  bannerMode.style.cssText = 'opacity:0.85;font-size:12px;';
  banner.appendChild(bannerText);
  banner.appendChild(bannerMode);
  document.documentElement.appendChild(banner);

  if (document.body) document.body.style.paddingTop = '38px';

  // Resume button (action-record mode shows the standard banner; the
  // blocked banner overlays the standard one with a red theme + button).
  var resumeBtn = document.createElement('button');
  resumeBtn.textContent = '✅ Risolto, riprendi';
  resumeBtn.style.cssText = [
    'background:white','color:#b91c1c','border:none','border-radius:4px',
    'padding:4px 10px','font-weight:bold','cursor:pointer','font-size:12px'
  ].join(';');
  resumeBtn.addEventListener('click', function () {
    send({ type: 'webrobot-picker-resume-request' });
  });

  function refreshBanner() {
    if (blockInfo) {
      banner.style.background = 'linear-gradient(90deg,#dc2626,#b91c1c)';
      bannerText.innerHTML = '🚨 <strong>Captcha / blocco rilevato</strong> (' + (blockInfo.kind || 'unknown') +
        ') — risolvi nella pagina sotto, poi premi "Risolto, riprendi".';
      bannerMode.innerHTML = '';
      bannerMode.appendChild(resumeBtn);
      return;
    }
    // Reset to default theme when leaving blocked state.
    banner.style.background = 'linear-gradient(90deg,#667eea,#764ba2)';
    // Anti-bot full-event mode overlay — narrower banner with a clear
    // distinction from the default action-record so the user knows
    // every mouse twitch is being recorded (and that this trace will
    // need HITL at replay time).
    if (antiBotMode && mode === 'action-record') {
      banner.style.background = 'linear-gradient(90deg,#7c2d12,#b91c1c)';
      bannerText.innerHTML = '🤖 <strong>Anti-bot capture:</strong> recording EVERY mouse / key / wheel event. This trace will require HITL at replay.';
      bannerMode.innerHTML = 'Captured: <strong>' + actions.length + ' events</strong>';
      return;
    }
    if (mode === 'action-record') {
      bannerText.innerHTML = '⏺ <strong>Action recorder:</strong> interact normally — clicks, typing, scrolls are recorded. ESC to stop.';
      bannerMode.innerHTML = 'Recorded: <strong>' + actions.length + ' action(s)</strong>';
    } else if (mode === 'selector-list') {
      bannerText.innerHTML = '🎯 <strong>List selector:</strong> click one element of the repeating pattern (cards, rows, items).';
      bannerMode.innerHTML = 'Mode: <strong>list (all similar)</strong>';
    } else if (mode === 'multi-field') {
      bannerText.innerHTML = '🎯 <strong>Multi-field picker:</strong> click each field you want to extract. Each click adds a row in the sidebar.' +
        (multiContainerSelector ? ' Clicks must be inside the segment container.' : '');
      bannerMode.innerHTML = 'Fields: <strong>' + multiFields.length + '</strong>';
    } else if (mode === 'multi-sample') {
      bannerText.innerHTML = '📍 <strong>Multi-link sampling:</strong> click 2+ examples of the repeating element. The picker computes a selector that matches them all.';
      var matchesPart = (multiSampleSelector && multiSampleSelector.matches)
        ? ' → <strong>' + multiSampleSelector.matches + ' matches</strong>'
        : '';
      bannerMode.innerHTML = 'Samples: <strong>' + multiSampleNodes.length + '</strong>' + matchesPart;
    } else if (mode === 'row-lca') {
      bannerText.innerHTML = '🧩 <strong>Row by 2 clicks:</strong> click the FIRST part of one row (e.g. the avatar), then the SECOND (e.g. the text) — their common container becomes the repeating row.';
      bannerMode.innerHTML = 'Mode: <strong>row (2 clicks → container)</strong>';
    } else {
      bannerText.innerHTML = '🎯 <strong>Selector picker:</strong> hover to highlight, click to pick. ESC to cancel.';
      bannerMode.innerHTML = 'Mode: <strong>single element</strong>';
    }
  }
  refreshBanner();

  function send(payload) {
    try { window.parent.postMessage(payload, '*'); } catch (_) {}
  }

  // ── 2. Parent → iframe ────────────────────────────────────────────
  // Highlights laid down by the parent (e.g. AI Magic candidates) are
  // tracked here so we can clear / replace them as new suggestions come in.
  var highlightStyleEl = null;
  var highlightedNodes = [];
  function clearHighlights() {
    highlightedNodes.forEach(function (n) {
      try { n.style.outline = ''; n.style.background = ''; } catch (_) {}
    });
    highlightedNodes = [];
    if (highlightStyleEl) {
      try { highlightStyleEl.parentNode.removeChild(highlightStyleEl); } catch (_) {}
      highlightStyleEl = null;
    }
  }
  function applyHighlights(layers) {
    // layers: [{selector, color, label, layer}, …]
    clearHighlights();
    if (!Array.isArray(layers) || layers.length === 0) return;
    var firstHit = null;
    layers.forEach(function (l) {
      if (!l || !l.selector) return;
      var nodes;
      try { nodes = document.querySelectorAll(l.selector); }
      catch (_) { return; }
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        try {
          el.style.outline = '2px solid ' + (l.color || '#fbbf24');
          el.style.background = (l.color || '#fbbf24') + '22';   // hex+alpha
        } catch (_) {}
        highlightedNodes.push(el);
        if (!firstHit) firstHit = el;
      }
    });
    if (firstHit) {
      try { firstHit.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
    }
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object') return;
    // EXTENSION: deactivate — stop intercepting clicks so the page navigates
    // normally (and Replay can drive it). Clears banner + hover highlight.
    if (d.type === 'webrobot-picker-mode' && d.mode === 'off') {
      pickerActive = false;
      try { window.__wrPickerOff = true; } catch (_) {}   // sync flag — see Replay
      actions = [];                 // reset recording buffer for the next session
      try { lcaFirst = null; } catch (_) {}
      try { if (typeof clearHover === 'function') clearHover(); } catch (_) {}
      try { if (banner) banner.style.display = 'none'; } catch (_) {}
      return;
    }
    if (d.type === 'webrobot-picker-mode' &&
        (d.mode === 'selector-single' || d.mode === 'selector-list' ||
         d.mode === 'action-record'   || d.mode === 'multi-field' ||
         d.mode === 'multi-sample'    || d.mode === 'row-lca')) {
      pickerActive = true;
      try { window.__wrPickerOff = false; } catch (_) {}
      try { if (banner) banner.style.display = ''; } catch (_) {}
      mode = d.mode;
      // Host tells us whether this stage FOLLOWS a link (explore/join/
      // visitExplore) so picks climb to the <a href>. Only update when the
      // key is present so an older host that omits it doesn't reset it.
      if (typeof d.linkMode === 'boolean') linkMode = d.linkMode;
      if (mode !== 'action-record') actions = [];
      if (mode !== 'multi-field') {
        // Leaving multi-field — clear the accumulated FIELD highlights.
        multiFields.forEach(function (f) {
        var ns = (f.nodes && f.nodes.length) ? f.nodes : (f.node ? [f.node] : []);
        ns.forEach(function (n) { try { n.style.outline = ''; n.style.background = ''; } catch (_) {} });
      });
        multiFields = [];
        // Keep multiContainerSelector for selector-single too: the
        // per-field 🎯 on flatSelect navigates (action-record) then
        // switches to selector-single, and the single-pick path now
        // computes RELATIVE to this container. Only drop it when we
        // leave BOTH container-aware modes (e.g. back to multi-sample
        // for picking a fresh row selector).
        if (mode !== 'selector-single' && mode !== 'action-record') {
          multiContainerSelector = null;
        }
      }
      if (mode !== 'multi-sample') {
        clearMultiSampleHighlights();
        multiSampleNodes = [];
        multiSampleSelector = null;
      }
      if (mode !== 'row-lca') {
        lcaHighlighted.forEach(function (n) { try { n.style.outline = ''; n.style.background = ''; } catch (_) {} });
        lcaHighlighted = [];
        lcaFirst = null;
      }
      refreshBanner();
    } else if (d.type === 'webrobot-generalize-result') {
      // Host's LLM segment inference came back with a generalized row
      // selector. Accept it ONLY if it actually matches more rows than the
      // heuristic AND still includes the element the user clicked — otherwise
      // keep the heuristic (never make the pick worse).
      var gSel = d && d.selector ? String(d.selector).trim() : '';
      if (gSel) {
        try {
          var gHits = document.querySelectorAll(gSel);
          var seedOk = !lastGeneralizeSeed;
          for (var gi = 0; gi < gHits.length; gi++) {
            if (gHits[gi] === lastGeneralizeSeed ||
                (lastGeneralizeSeed && gHits[gi].contains(lastGeneralizeSeed))) { seedOk = true; break; }
          }
          var prevMatches = multiSampleSelector ? multiSampleSelector.matches : 0;
          if (gHits.length > 1 && gHits.length > prevMatches && seedOk) {
            multiSampleSelector = { selector: gSel, matches: gHits.length };
            applyMultiSampleHighlight(gSel);
            refreshBanner();
            send({
              type: 'webrobot-pick-multi-sample',
              selector: gSel,
              matches: gHits.length,
              samples: multiSampleNodes.length,
              generalized: true,
            });
            console.debug('[picker.js] AI-generalized row selector:', gSel,
                          '(' + gHits.length + ' rows)');
          } else {
            console.debug('[picker.js] AI-generalize rejected (hits=' + gHits.length +
                          ', prev=' + prevMatches + ', seedOk=' + seedOk + ')');
          }
        } catch (_) {}
      }
      lastGeneralizeSeed = null;
    } else if (d.type === 'webrobot-picker-multi-config') {
      // Configure container selector for multi-field mode (used by flatSelect).
      multiContainerSelector = d.containerSelector || null;
      refreshBanner();
      // Paint row-number badges on every container match so the user
      // sees "this is row 1 of N" while picking fields. Mirrors how
      // spreadsheet row headers help orient. Idempotent — paintRowNumbers
      // skips containers that already have a badge.
      try { paintRowNumbers(); } catch (_) {}
    } else if (d.type === 'webrobot-picker-multi-clear') {
      multiFields.forEach(function (f) {
        var ns = (f.nodes && f.nodes.length) ? f.nodes : (f.node ? [f.node] : []);
        ns.forEach(function (n) { try { n.style.outline = ''; n.style.background = ''; } catch (_) {} });
      });
      multiFields = [];
      refreshBanner();
    } else if (d.type === 'webrobot-picker-multi-restore') {
      // Parent reopened the picker on a stage that already carries
      // row._fields. Re-resolve every field selector against the
      // current DOM and re-paint the outline + background so the user
      // sees what's already saved and can decide to add more or
      // remove individual entries.
      multiFields.forEach(function (f) {
        var ns = (f.nodes && f.nodes.length) ? f.nodes : (f.node ? [f.node] : []);
        ns.forEach(function (n) { try { n.style.outline = ''; n.style.background = ''; } catch (_) {} });
      });
      multiFields = [];
      var restore = Array.isArray(d.fields) ? d.fields : [];
      for (var ri = 0; ri < restore.length; ri++) {
        var entry = restore[ri] || {};
        var sel = entry.selector;
        if (!sel) continue;
        var color = entry.color || multiPalette[multiFields.length % multiPalette.length];
        // Cross-row highlight on restore too: when a container is set,
        // light up the field in every segment row — same UX as the
        // live pick path.
        var nodes = applyMultiFieldHighlight(sel, color, multiContainerSelector);
        var primary = nodes[0] || null;
        if (!primary) {
          // Fall back to a global querySelector when there's no
          // container or no matches inside containers (e.g. the user
          // saved a field before setting the segment selector).
          try { primary = document.querySelector(sel); } catch (_) {}
          if (primary) {
            try { primary.style.outline = '3px solid ' + color; primary.style.background = color + '22'; } catch (_) {}
            nodes = [primary];
          }
        }
        if (!primary) continue;
        multiFields.push({
          selector:   sel,
          sampleText: entry.sampleText || (primary.innerText || primary.textContent || '').trim().slice(0, 200),
          sampleHtml: entry.sampleHtml || (primary.outerHTML || '').slice(0, 400),
          color:      color,
          node:       primary,
          nodes:      nodes,
          label:      entry.label || null,
        });
      }
      refreshBanner();
    } else if (d.type === 'webrobot-picker-stop-recording') {
      if (mode === 'action-record') {
        send({ type: 'webrobot-pick-actions', actions: actions });
        actions = [];
        refreshBanner();
      }
    } else if (d.type === 'webrobot-picker-flush-queue') {
      // Parent is about to send the staged batch to Camoufox. Commit
      // any in-progress typing first so the Send always includes the
      // freshest field value, then ship the queue + reset locally.
      if (mode === 'action-record') {
        flushPendingType();
        send({ type: 'webrobot-pick-actions', actions: actions });
        actions = [];
        refreshBanner();
      }
    } else if (d.type === 'webrobot-picker-clear-queue') {
      // Parent "Clear staged" button: wipe the local queue too, otherwise
      // the next pick-actions ping would resurrect the list parent-side.
      // No round-trip — just drop everything.
      actions = [];
      lastInputTarget = null;
      refreshBanner();
      send({ type: 'webrobot-pick-actions', actions: actions });
    } else if (d.type === 'webrobot-highlight') {
      applyHighlights(d.layers || []);
    } else if (d.type === 'webrobot-picker-sample-fields') {
      // Parent (after LLM auto-suggest) wants the VALUE each suggested selector
      // resolves to ON THIS PAGE — the LLM returns selectors, not values, so the
      // field list shows no sample. Resolve each selector and send back text +
      // html. Also feeds multi-page consolidation (one sample per visited page).
      var sels = Array.isArray(d.selectors) ? d.selectors : [];
      var fsamples = sels.map(function (sel) {
        var el = null;
        try { el = document.querySelector(sel); } catch (_) {}
        return {
          selector: sel,
          matched: !!el,
          text: el ? (el.innerText || el.textContent || '').trim().slice(0, 200) : null,
          html: el ? (el.outerHTML || '').slice(0, 2000) : null,
        };
      });
      send({ type: 'webrobot-picker-field-samples', samples: fsamples });
    } else if (d.type === 'webrobot-highlight-clear') {
      clearHighlights();
    } else if (d.type === 'webrobot-picker-block') {
      // Parent saw a `block` field in /cmf/open or /cmf/step response.
      // Suspend our click/key interception so the user can interact
      // with the captcha widget natively, and show the red banner.
      blockInfo = d.block || null;
      refreshBanner();
    } else if (d.type === 'webrobot-picker-block-clear') {
      // Parent's /cmf/resume succeeded (or the user dismissed the
      // banner) — restore the normal picker banner + interception.
      blockInfo = null;
      refreshBanner();
    }
  });

  // ── 3. Hover highlight (selector mode only) ───────────────────────
  function clearHover() {
    if (hovered && hovered !== pickedNode) {
      try { hovered.style.outline = prevOutlines.get(hovered) || ''; } catch (_) {}
      // Reset the not-allowed cursor we may have set for out-of-container
      // hovers in multi-field mode.
      try { hovered.style.cursor = ''; } catch (_) {}
    }
    hovered = null;
  }
  // Action-record hover capture: when the user lands on a menu / dropdown
  // trigger (heuristic: descendant looks like a JS-revealed sub-menu)
  // record a Hover(selector) so the replay opens the sub-menu before
  // clicking a child link. Throttled + deduped to keep mousewander quiet.
  var lastHoverCaptureAt = 0;
  var lastHoverCaptureSelector = '';
  function hasHoverRevealedChild(el) {
    if (!el || !el.querySelector) return false;
    // Viewport-size cap: a menu/dropdown TRIGGER is a small UI element
    // (button, nav link, menu label) — NOT a layout wrapper that happens
    // to contain a menu somewhere deep in its subtree. Without this, on
    // sites with global navigation (Bazaraki: #mainContent > div.flex...)
    // every mouseover on the body wrapper trips the check (because the
    // header menu down the tree matches [role=menu] etc.) and replay
    // later times out on `hover(selectorOfWholeWrapper)` because the
    // element isn't actually a hover-revealing trigger.
    //
    // Threshold: 30% of viewport in either axis. Empirically large
    // enough for a megamenu trigger label, small enough to reject
    // any layout container.
    try {
      var r  = el.getBoundingClientRect();
      var vw = window.innerWidth  || 1;
      var vh = window.innerHeight || 1;
      if (r.width > vw * 0.3 || r.height > vh * 0.3) return false;
      if (r.width < 4 || r.height < 4) return false;  // not interactable
    } catch (_) { /* ignore — proceed with the descendant scan */ }
    // Also require the element to look interactive itself — otherwise a
    // <section> with semantic role somewhere inside still trips. Loose
    // heuristic: a tag that's commonly the hover-trigger (a / button /
    // li / [role=button] / [aria-haspopup]) or has tabIndex >= 0.
    try {
      var tag = (el.tagName || '').toLowerCase();
      var isInteractive =
        tag === 'a' || tag === 'button' || tag === 'li' || tag === 'span' ||
        el.hasAttribute && (
          el.hasAttribute('aria-haspopup') ||
          el.hasAttribute('aria-expanded') ||
          (el.getAttribute && (el.getAttribute('role') === 'button' ||
                               el.getAttribute('role') === 'menuitem'))
        ) ||
        (el.tabIndex != null && el.tabIndex >= 0);
      if (!isInteractive) return false;
    } catch (_) { /* be lenient on the interactivity check */ }
    try {
      return !!el.querySelector(
        '[role=menu],[aria-haspopup],[aria-expanded],' +
        '.dropdown-menu,.submenu,.megamenu,.popover,' +
        'ul.children,.nav-dropdown'
      );
    } catch (_) { return false; }
  }
  document.addEventListener('mouseover', function (e) {
    if (e.target === banner || banner.contains(e.target)) return;
    if (blockInfo) return; // suspend during captcha resolution
    if (mode === 'action-record') {
      var el = e.target;
      if (!hasHoverRevealedChild(el)) return;
      var now = Date.now();
      if (now - lastHoverCaptureAt < 300) return;
      var hsel = computeSelector(el, 'single');
      if (hsel === lastHoverCaptureSelector) return;
      lastHoverCaptureAt = now;
      lastHoverCaptureSelector = hsel;
      if (lastInputTarget) {
        var val = lastInputTarget.value || '';
        if (val) actions.push({ type: 'Type', selector: computeSelector(lastInputTarget, 'single'), text: val });
        lastInputTarget = null;
      }
      actions.push({ type: 'Hover', selector: hsel });
      refreshBanner();
      send({ type: 'webrobot-pick-actions', actions: actions });
      return;
    }
    clearHover();
    hovered = e.target;
    if (hovered === pickedNode) return;
    if (!prevOutlines.has(hovered)) prevOutlines.set(hovered, hovered.style.outline || '');
    // In multi-field mode with a container constraint, give the user
    // a visual signal that out-of-container hovers are NOT pickable:
    // paint them with a forbidden-style red outline instead of the
    // usual blue hover. The click handler still emits a warn() and
    // bails on the actual click, but the hover signal makes the
    // constraint visible BEFORE the click — so the user can correct
    // course without seeing a toast pop up after every miss.
    if (mode === 'multi-field' && multiContainerSelector) {
      var inContainer = false;
      try {
        var cs = document.querySelectorAll(multiContainerSelector);
        for (var hci = 0; hci < cs.length; hci++) {
          if (cs[hci].contains(hovered)) { inContainer = true; break; }
        }
      } catch (_) {}
      if (!inContainer) {
        try {
          hovered.style.outline = '2px dashed #d32f2f';
          hovered.style.cursor = 'not-allowed';
        } catch (_) {}
        return;
      }
    }
    try { hovered.style.outline = STYLE_HOVER; } catch (_) {}
  }, true);
  document.addEventListener('mouseout', function () {
    if (mode === 'action-record') return;
    clearHover();
  }, true);

  // Form submit guard. The click handler already preventDefault()'s the
  // submit-button click in action-record mode, which usually stops the
  // browser's implicit form submission. But Enter inside an <input> in
  // a <form> emits a SEPARATE 'submit' event (not a click), which would
  // navigate the iframe without staging the Type → causing the user's
  // "trace recording" to show a navigation they didn't explicitly
  // commit. Match the click semantic: in action-record we stage
  // whatever's pending then preventDefault the submit. The actual
  // Click + Type are replayed when the user presses "▶ Send".
  // Captcha path (blockInfo) intentionally lets submits through —
  // some challenge widgets submit a hidden form to finalize.
  document.addEventListener('submit', function (e) {
    if (blockInfo) return;
    if (mode !== 'action-record') return;
    // Stage any pending Type, plus a synthetic "submit click" on the
    // form's submit element if findable. The user gestures (typing +
    // clicking) are what matter for replay — the form submission
    // itself is implied.
    if (lastInputTarget) {
      var v = lastInputTarget.value || '';
      if (v) actions.push({ type: 'Type', selector: computeSelector(lastInputTarget, 'single'), text: v });
      lastInputTarget = null;
    }
    try {
      var submitter = e.submitter || (e.target && e.target.querySelector
          ? (e.target.querySelector('button[type="submit"], input[type="submit"]') || null)
          : null);
      if (submitter) {
        actions.push({ type: 'Click', selector: computeSelector(submitter, 'single') });
      }
    } catch (_) {}
    refreshBanner();
    send({ type: 'webrobot-pick-actions', actions: actions });
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  // ── 3.9 Navigation guard (CAPTURE phase, runs BEFORE the page's own
  //        handlers) ───────────────────────────────────────────────────
  // The mirror must NEVER perform a native cross-document navigation: every
  // link/navigation has to be intercepted and forwarded to Camoufox (staged
  // as a Click/Visit action). preventDefault EVERY <a href> click here,
  // regardless of mode and regardless of whether the site's SPA router is
  // present (it may be stripped). Propagation continues, so the bubble-phase
  // handler below still stages/picks. Banner UI and captcha flow are exempt.
  document.addEventListener('click', function (e) {
    if (!pickerActive || window.__wrPickerOff) return; // EXTENSION: idle → let links navigate normally
    if (e.target === banner || (banner && banner.contains(e.target))) return;
    if (blockInfo) return; // captcha: let the challenge widget handle clicks
    var navAnchor = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (navAnchor) {
      // Don't block in-page anchors (#frag) — those don't navigate away.
      var href = navAnchor.getAttribute('href') || '';
      if (!(href.charAt(0) === '#')) e.preventDefault();
    }
  }, true);

  // ── 4. Click handling ─────────────────────────────────────────────
  // In selector modes: preventDefault + post a pick.
  // In action mode: observe + record, let the page handle normally.
  document.addEventListener('click', function (e) {
    if (!pickerActive || window.__wrPickerOff) return; // EXTENSION: idle → don't intercept page clicks
    if (e.target === banner || banner.contains(e.target)) return;
    // When blocked by a captcha, let the page handle clicks natively
    // so the user can solve the challenge. The page won't be navigated
    // away because the challenge widget eats the click itself.
    if (blockInfo) return;

    if (mode === 'row-lca') {
      // Two-click row definition: click two separate parts of ONE row (e.g. the
      // avatar block + the comment body); their lowest common ancestor is the
      // repeating row container. Solves rows that aren't a single clickable box.
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      var clk = e.target;
      if (!lcaFirst) {
        lcaFirst = clk;
        try { clk.style.outline = '3px solid #6366f1'; clk.style.background = '#6366f122'; } catch (_) {}
        lcaHighlighted = [clk];
        if (bannerText) bannerText.innerHTML = '🧩 <strong>Row by 2 clicks:</strong> first part captured — now click the OTHER part of the SAME row.';
        return;
      }
      var lca = commonAncestor(lcaFirst, clk);
      lcaHighlighted.forEach(function (n) { try { n.style.outline = ''; n.style.background = ''; } catch (_) {} });
      lcaHighlighted = [];
      lcaFirst = null;
      if (!lca || lca === document.body || lca === document.documentElement) {
        if (bannerText) bannerText.innerHTML = '🧩 No common row container — click two parts of the SAME row (closer together).';
        return;
      }
      var lsel = computeSelector(lca, 'list');
      var lmatches = 0; try { lmatches = document.querySelectorAll(lsel).length; } catch (_) {}
      try { lca.style.outline = '3px solid #43a047'; lca.style.background = '#43a04722'; } catch (_) {}
      send({ type: 'webrobot-pick-selector', selector: lsel, mode: 'row-lca', matches: lmatches,
             sampleText: (lca.innerText || lca.textContent || '').trim().slice(0, 200),
             sampleHtml: (lca.outerHTML || '').slice(0, 400),
             sampleHtmlFull: (lca.outerHTML || '').slice(0, 12000) });
      refreshBanner();
      return;
    }

    if (mode === 'action-record') {
      // Two sub-modes, decided by what the user just clicked:
      //   editable target (input/textarea/contenteditable) → STAGE only.
      //     The user is about to type; we MUST NOT navigate, and we
      //     re-focus the element so the keystrokes actually land in
      //     the iframe's local input (preventDefault would otherwise
      //     block native focus).
      //   anything else (link, button, submit, normal element) → STAGE
      //     plus AUTO-SEND. That click is the user's "commit" gesture
      //     for whatever they typed and clicked before, and replays
      //     the whole queue on Camoufox.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      var tag = (e.target && e.target.tagName || '').toLowerCase();
      var editable = tag === 'input' || tag === 'textarea'
                  || (e.target && e.target.isContentEditable);
      // <select> is not really editable for our purposes — Playwright
      // uses selectOption() not click() to change it — but clicking a
      // select on a real page opens the dropdown, which is a "commit"
      // interaction, so it goes through the auto-send path.
      if (editable) {
        try { e.target.focus({ preventScroll: true }); } catch (_) { try { e.target.focus(); } catch (__) {} }
      }
      // Walk up to the closest <a href> ancestor when the user clicks
      // a descendant of a link (very common on SPA card layouts —
      // ebay's s-card__link wraps a span.title; clicking the span
      // dispatches the event on the span and the SPA's router checks
      // event.target.tagName === 'A' before firing navigation, so it
      // never fires). Targeting the anchor instead bubbles cleanly
      // and the runtime always has the right href.
      var clickTarget = e.target;
      if (!editable && clickTarget && clickTarget.closest) {
        var anchor = clickTarget.closest('a[href]');
        if (anchor && anchor !== clickTarget) clickTarget = anchor;
      }
      var sel = computeSelector(clickTarget, 'single');
      // Any pending Type (user just typed in another input) gets
      // committed to the queue BEFORE this click — same ordering the
      // server would see if we were live-forwarding.
      if (lastInputTarget) {
        var val = lastInputTarget.value || '';
        if (val) actions.push({ type: 'Type', selector: computeSelector(lastInputTarget, 'single'), text: val });
        lastInputTarget = null;
      }
      actions.push({ type: 'Click', selector: sel });
      refreshBanner();
      // Always tell the parent the new queue length so the "▶ Send"
      // count updates.
      send({ type: 'webrobot-pick-actions', actions: actions });
      // NOTE: previous behaviour auto-committed the queue here on every
      // non-editable click ("submit-style" auto-send). Removed by user
      // request — the explicit "▶ Send to Camoufox" button is now the
      // ONLY commit gesture. Two reasons:
      //   1. Anti-bot/captcha flow: the user is mid-gesturing through a
      //      challenge and an auto-send between gesture frames clobbers
      //      the trace (the partial batch lands without the full mouse
      //      trajectory, fails the CMP fingerprint, then the next batch
      //      is too small to look human either).
      //   2. Even outside captcha, auto-commit on link/button click was
      //      surprising — the user staged 3 things, clicked the 4th, and
      //      ALL 4 fired with no review opportunity.
      // The "▶ Send (N)" button + queue count are the contract now.
      return;
    }

    if (mode === 'multi-field') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // If a container is configured, the picked element MUST live
      // inside one of its matches. The resulting selector is computed
      // RELATIVE to that container so it can be applied as a per-row
      // flatSelect extractor at runtime.
      var picked = e.target;
      var relSel = null;
      var containerNode = null;
      var isParallelField = false;   // set when the field is OUTSIDE the segment (split row → parallelSelect)
      console.debug('[picker.js] multi-field click — multiContainerSelector=',
                    multiContainerSelector, 'picked=', picked && picked.tagName,
                    'pickedClasses=', picked && picked.className);
      if (multiContainerSelector) {
        // Prefer Element.closest() — it returns the CLOSEST ancestor
        // (or self) matching the selector, i.e. the deepest container
        // wrapping `picked`. Iterating querySelectorAll + contains()
        // picks whichever match comes FIRST in document order; if the
        // selector accidentally matches nested elements (or a row
        // wrapper AND its parent both match), the first-in-document
        // is the wrapper, and the resulting "relative" chain includes
        // the row tag — exactly the "field selector includes the row
        // selector" bug we're fixing. closest() is monotonic.
        try {
          containerNode = picked.closest(multiContainerSelector);
        } catch (_) {}
        if (!containerNode) {
          // Field OUTSIDE the segment → SPLIT row (parallel sibling list with
          // no common per-row wrapper, e.g. an avatar block + the comment body).
          // Capture it PAGE-ROOTED + flag parallel; the host generator then
          // emits parallelSelect (cardinality join, zipped by index) instead of
          // flatSelect — the user never had to choose the stage.
          relSel = computeSelector(picked, 'list');
          isParallelField = true;
        } else {
        // GENERIC-FIRST: start with a class-pattern relative selector
        // that should already match the same logical column in every
        // row, no second-click needed.  If the result overshoots
        // (matches 2+ elements inside a single container — too loose)
        // or misses (doesn't match the picked element at all — wrong
        // structure), fall back to the strict path with auto-relax.
        var genericSel = computeRelativeSelectorGeneric(picked, containerNode);
        var genericOK = false;
        try {
          var sampleHit = containerNode.querySelectorAll(genericSel);
          var pickedAmongHits = false;
          for (var gi = 0; gi < sampleHit.length; gi++) {
            if (sampleHit[gi] === picked) { pickedAmongHits = true; break; }
          }
          if (pickedAmongHits) {
            var stats = countMatchesPerContainer(genericSel);
            // Accept if every container has at most 1 hit (no overshoot).
            if (stats.overshoots === 0 && stats.hits >= 1) {
              relSel = genericSel;
              genericOK = true;
              console.debug('[picker.js] generic-first selector:', genericSel,
                            '(hits=' + stats.hits + '/' + stats.containers + ')');
            }
          }
        } catch (_) {}
        if (!genericOK) {
          relSel = computeSelectorRelativeTo(picked, containerNode);
          var relaxed = autoRelaxRelativeSelector(relSel);
          if (relaxed && relaxed !== relSel) {
            console.debug('[picker.js] auto-relax:', relSel, '→', relaxed);
            relSel = relaxed;
          }
        }
        }
      } else {
        relSel = computeSelector(picked, 'single');
      }

      // ── Auto-merge: detect "same logical field, different row" ────
      // If the user clicks the SAME column in a different row (e.g.
      // first the price in row 1, then the price in row 2), we don't
      // want a duplicate "price_2" field — we want to GENERALISE the
      // existing field's selector to cover both clicks.
      //
      // Heuristic for a merge candidate:
      //   - existing field's seed is connected in the DOM
      //   - same leaf tag as the new click
      //   - seed lives in a DIFFERENT container than the new pick (same
      //     container = a genuine NEW field on the same row)
      //   - the existing field's selector, stripped of :nth-of-type,
      //     matches the new picked element when querySelector'd inside
      //     the new container — strong signal it's the same "column"
      var mergeIdx = -1;
      if (multiContainerSelector && containerNode) {
        var newLeaf = picked.tagName ? picked.tagName.toLowerCase() : '';
        for (var mi = 0; mi < multiFields.length; mi++) {
          var f = multiFields[mi];
          if (!f.node || !f.node.isConnected) continue;
          var fLeaf = f.node.tagName ? f.node.tagName.toLowerCase() : '';
          if (fLeaf !== newLeaf) continue;
          // Find existing field's container
          var fContainer = null;
          try {
            var cs2 = document.querySelectorAll(multiContainerSelector);
            for (var ci2 = 0; ci2 < cs2.length; ci2++) {
              if (cs2[ci2].contains(f.node)) { fContainer = cs2[ci2]; break; }
            }
          } catch (_) {}
          if (!fContainer || fContainer === containerNode) continue;
          // Try the existing selector relaxed → does it pick the new
          // element when applied to the new container?  Use
          // querySelectorAll + indexOf instead of `querySelector === picked`:
          // querySelector only returns the FIRST matching descendant,
          // which can be a sibling (e.g. `<span>name</span>` before
          // `<span>price</span>`) — the user actually clicked a different
          // matching node further down. Including-check survives that.
          var relaxed = (f.selector || '').replace(/:nth-of-type\(\d+\)/g, '').replace(/\s+>\s+/g, ' > ').trim();
          try {
            if (relaxed) {
              var hits = containerNode.querySelectorAll(relaxed);
              if (hits.length) {
                for (var hi = 0; hi < hits.length; hi++) {
                  if (hits[hi] === picked) { mergeIdx = mi; break; }
                }
                if (mergeIdx >= 0) break;
              }
            }
          } catch (_) {}
          // Secondary semantic signal: classify both sample texts via a
          // cheap regex (price / rating / url / date / generic). If both
          // clicks classify to the same non-generic bucket and live in
          // different containers, that's a strong "same column" signal
          // even when the structural selector match was inconclusive.
          if (mergeIdx < 0) {
            var classifyText = function (t) {
              if (!t) return 'empty';
              t = String(t).trim();
              if (/^[€$£¥]\s*[\d.,]+|[\d.,]+\s*[€$£¥]/.test(t))         return 'price';
              if (/^\d+([.,]\d+)?\s*(stars?|★+|\/\s*5)/i.test(t))         return 'rating';
              if (/^https?:\/\//.test(t))                                  return 'url';
              if (/^\d{4}[\/\-]\d{2}[\/\-]\d{2}/.test(t))                 return 'date';
              if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(t))          return 'date';
              return 'generic';
            };
            var newKind = classifyText(picked.innerText || picked.textContent);
            var oldKind = classifyText(f.sampleText);
            if (newKind !== 'generic' && newKind !== 'empty' && newKind === oldKind) {
              mergeIdx = mi;
              break;
            }
          }
        }
      }

      if (mergeIdx >= 0) {
        // Generalise the existing field instead of adding a new one.
        var fOld = multiFields[mergeIdx];
        var newSel = (fOld.selector || '').replace(/:nth-of-type\(\d+\)/g, '').replace(/\s+>\s+/g, ' > ').trim();
        // Confirm it still matches the original seed too (sanity)
        var oldStillMatches = false;
        try { oldStillMatches = !!fOld.node && !!fOld.node.isConnected; } catch (_) {}
        if (!oldStillMatches) { newSel = relSel; }
        // Wipe old highlights
        var prevNodes = (fOld.nodes && fOld.nodes.length) ? fOld.nodes : (fOld.node ? [fOld.node] : []);
        prevNodes.forEach(function (n) {
          try { n.style.outline = ''; n.style.background = ''; } catch (_) {}
        });
        var refreshedNodes = applyMultiFieldHighlight(newSel, fOld.color, multiContainerSelector);
        if (refreshedNodes.length === 0) { refreshedNodes = [picked, fOld.node]; }
        fOld.selector = newSel;
        fOld.nodes    = refreshedNodes;
        refreshBanner();
        try { paintRowNumbers(); } catch (_) {}
        // Tell parent to REFINE existing field, not append.
        send({
          type: 'webrobot-pick-multi-field-refine',
          index: mergeIdx,
          selector: newSel,
          color: fOld.color,
          containerSelector: multiContainerSelector,
          matches: refreshedNodes.length,
        });
        return;
      }

      // No merge candidate — append as new field.
      var color = multiPalette[multiFields.length % multiPalette.length];
      var sampleText = (picked.innerText || picked.textContent || '').trim().slice(0, 200);
      var sampleHtml = (picked.outerHTML || '').slice(0, 400);
      // When a container is configured (flatSelect-style segment selector),
      // the relative selector should resolve inside EVERY container match.
      // Highlight all of them so the user sees the column at a glance and
      // can sanity-check the selector before committing.
      var highlightNodes = applyMultiFieldHighlight(relSel, color, multiContainerSelector);
      // Re-paint row badges (lazy-loaded rows may have appeared since
      // the initial multi-config message).
      try { paintRowNumbers(); } catch (_) {}
      // Fall back to just the clicked node if the relative selector found
      // nothing (e.g. weird DOM where the picked node sits outside its
      // logical container).
      if (highlightNodes.length === 0) {
        try { picked.style.outline = '3px solid ' + color; picked.style.background = color + '22'; } catch (_) {}
        highlightNodes = [picked];
      }
      // Persist the field outline across hover. clearHover() restores
      // the previous outline value from prevOutlines, so if the user
      // mouses over an already-highlighted cross-row match, the green
      // would get wiped on mouseout. Seed prevOutlines with the field
      // color so hover-out restores back to it instead of empty.
      var fieldOutline = '3px solid ' + color;
      highlightNodes.forEach(function (n) {
        try { prevOutlines.set(n, fieldOutline); } catch (_) {}
      });
      var entry = { selector: relSel, sampleText: sampleText, sampleHtml: sampleHtml, color: color,
                    node: picked, nodes: highlightNodes, parallel: isParallelField };
      multiFields.push(entry);
      refreshBanner();
      // Tell the parent — strip the node reference (non-serializable).
      // Verbose log so the host can correlate clicks ↔ emitted
      // selectors when investigating dedup misses.
      console.debug('[picker.js] webrobot-pick-multi-field emit:',
                    'selector=', entry.selector,
                    'container=', multiContainerSelector,
                    'matches=', highlightNodes.length,
                    'multiFields.length=', multiFields.length);
      send({
        type: 'webrobot-pick-multi-field',
        index: multiFields.length - 1,
        selector: entry.selector,
        sampleText: entry.sampleText,
        sampleHtml: entry.sampleHtml,
        color: entry.color,
        parallel: entry.parallel,
        containerSelector: multiContainerSelector,
        matches: highlightNodes.length,
        attributes: elementAttrNames(picked),
      });
      return;
    }

    if (mode === 'multi-sample') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      var seed = e.target;
      // Link-following stage: climb to the nearest <a href> so the sampled
      // selector targets the LINK (with an href to Visit), not the inner
      // text span (href=N/A → no navigation at runtime).
      if (linkMode && seed && seed.closest) {
        var seedAnchor = seed.closest('a[href]');
        if (seedAnchor) seed = seedAnchor;
      }
      // Don't double-count the same node — also rejects accidental
      // duplicate clicks on already-highlighted siblings.
      if (multiSampleNodes.indexOf(seed) === -1) multiSampleNodes.push(seed);
      multiSampleSelector = computeCommonListSelector(multiSampleNodes);
      applyMultiSampleHighlight(multiSampleSelector ? multiSampleSelector.selector : null);
      refreshBanner();
      var msMatches = multiSampleSelector ? multiSampleSelector.matches : 0;
      send({
        type: 'webrobot-pick-multi-sample',
        selector: multiSampleSelector ? multiSampleSelector.selector : null,
        matches:  msMatches,
        samples:  multiSampleNodes.length,
        sampleText: (seed.innerText || seed.textContent || '').trim().slice(0, 200),
        sampleHtml: (seed.outerHTML || '').slice(0, 400),
      });
      // Detect a self-NESTED structure (threaded comments): the clicked box's
      // own tag repeats in one of its ancestors → the items live at multiple
      // depths (Reddit <shreddit-comment depth=N>, nested .comment, …). A flat
      // sibling intersection misses the deeper levels, so we want the LLM to
      // return a depth-agnostic selector matching every node at every depth.
      var leafTag = seed.tagName ? seed.tagName.toLowerCase() : '';
      var nested = false;
      try {
        var anc = seed.parentElement;
        while (anc && anc !== document.body) {
          if (anc.tagName && anc.tagName.toLowerCase() === leafTag) { nested = true; break; }
          anc = anc.parentElement;
        }
      } catch (_) {}

      // AI-generalize at pick: fire when the heuristic is weak (matches ≤ 1 —
      // hashed classes) OR the structure is self-nested (comments). Send the
      // clicked box + its parent HTML (for nested, the box already contains
      // its replies — enough context for the recursive pattern). The host
      // runs LLM segment inference and replies with webrobot-generalize-result.
      // Only on a SINGLE seed — 2+ clicks mean the user is intersecting manually.
      if (multiSampleNodes.length === 1 && (msMatches <= 1 || nested)) {
        try {
          var parentEl = seed.parentElement;
          var ctxHtml = (parentEl ? parentEl.outerHTML : seed.outerHTML) || '';
          // Cap to keep the LLM payload small.
          if (ctxHtml.length > 12000) ctxHtml = ctxHtml.slice(0, 12000);
          lastGeneralizeSeed = seed;
          send({
            type: 'webrobot-generalize-request',
            selector: multiSampleSelector ? multiSampleSelector.selector : null,
            html: ctxHtml,
            sampleText: (seed.innerText || seed.textContent || '').trim().slice(0, 200),
            nested: nested,
          });
          console.debug('[picker.js] AI generalize requested (matches=' + msMatches +
                        ', nested=' + nested + ')');
        } catch (_) {}
      }
      return;
    }

    // Selector modes
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // Link-following stage: climb to the nearest <a href> so the selector
    // targets the LINK (href present), not the inner text span.
    var clicked = e.target;
    if (linkMode && clicked && clicked.closest) {
      var clickedAnchor = clicked.closest('a[href]');
      if (clickedAnchor) clicked = clickedAnchor;
    }
    if (pickedNode && pickedNode !== clicked) {
      try { pickedNode.style.outline = prevOutlines.get(pickedNode) || ''; } catch (_) {}
    }
    pickedNode = clicked;
    if (!prevOutlines.has(pickedNode)) prevOutlines.set(pickedNode, pickedNode.style.outline || '');
    try { pickedNode.style.outline = STYLE_PICKED; } catch (_) {}

    var selMode = mode === 'selector-list' ? 'list' : 'single';
    var selector;

    // CONTAINER-RELATIVE single pick. When a row/segment container is
    // configured (flatSelect per-field 🎯), the field selector MUST be
    // relative to the row — never an absolute path that includes the
    // wrapper (ul.srp-results …) and the row's :nth-of-type(N). Compute
    // it exactly like the multi-field bulk picker: generic class-pattern
    // first, strict relative + auto-relax as fallback. This keeps single
    // per-field picks consistent with bulk picks and avoids the "unique
    // absolute selector locked to one row" bug.
    var relContainer = null;
    if (multiContainerSelector) {
      try { relContainer = pickedNode.closest(multiContainerSelector); } catch (_) {}
    }
    if (relContainer) {
      var rGeneric = computeRelativeSelectorGeneric(pickedNode, relContainer);
      var rOK = false;
      try {
        var rHits = relContainer.querySelectorAll(rGeneric);
        var rAmong = false;
        for (var rgi = 0; rgi < rHits.length; rgi++) {
          if (rHits[rgi] === pickedNode) { rAmong = true; break; }
        }
        if (rAmong) {
          var rStats = countMatchesPerContainer(rGeneric);
          if (rStats.overshoots === 0 && rStats.hits >= 1) {
            selector = rGeneric;
            rOK = true;
            console.debug('[picker.js] container-relative single (generic):', rGeneric,
                          '(hits=' + rStats.hits + '/' + rStats.containers + ')');
          }
        }
      } catch (_) {}
      if (!rOK) {
        selector = computeSelectorRelativeTo(pickedNode, relContainer);
        var rRelaxed = autoRelaxRelativeSelector(selector);
        if (rRelaxed && rRelaxed !== selector) {
          console.debug('[picker.js] container-relative single (auto-relax):', selector, '→', rRelaxed);
          selector = rRelaxed;
        }
      }
    } else {
      // GENERIC-FIRST. Compute the broadest class-pattern selector ('list'
      // style — no #id, no :nth-of-type) and check how it lands on the
      // current page:
      //   - 1 hit (= the picked element)        → generic is perfect, use it
      //   - >1 hits AND selMode='list'          → also fine (we WANT siblings)
      //   - >1 hits AND selMode='single'        → ambiguous on current page,
      //                                            fall back to specific
      //                                            ('single' style with
      //                                            :nth-of-type / id)
      //   - 0 hits (weird/broken)               → fall back to specific
      // Net: extract per-field picks produce class-based selectors that
      // generalise across similar detail pages by default.
      try {
        var genericSel = computeSelector(pickedNode, 'list');
        var genericHits = document.querySelectorAll(genericSel);
        if (genericHits.length === 1 && genericHits[0] === pickedNode) {
          selector = genericSel;
        } else if (genericHits.length > 1 && selMode === 'list') {
          selector = genericSel;
        } else {
          selector = computeSelector(pickedNode, selMode);
        }
      } catch (_) {
        selector = computeSelector(pickedNode, selMode);
      }
    }
    var matches = 0;
    var matchNodes = [];
    try {
      if (relContainer) {
        // Relative selector: resolve it inside EVERY container so the
        // match count reflects "one hit per row" and the highlight
        // lights up the same field across all rows — not a global
        // document query (which would fail / mis-count on a relative
        // chain).
        var rContainers = document.querySelectorAll(multiContainerSelector);
        for (var rci = 0; rci < rContainers.length; rci++) {
          var rHit = null;
          try { rHit = rContainers[rci].querySelector(selector); } catch (_) {}
          if (rHit) matchNodes.push(rHit);
        }
        matches = matchNodes.length;
      } else {
        matchNodes = Array.prototype.slice.call(document.querySelectorAll(selector));
        matches = matchNodes.length;
      }
    } catch (_) {}
    // Soft-highlight every OTHER match so the user sees the full
    // extent of the selector at a glance — critical for flatSelect
    // segment confirmation ("did clicking 1 row really pick all 24?").
    // The clicked node keeps the STYLE_PICKED solid green outline;
    // siblings get a softer dashed green + 10% green bg.
    clearListMatchHighlights();
    for (var mi = 0; mi < matchNodes.length; mi++) {
      var mNode = matchNodes[mi];
      if (mNode === pickedNode) continue;
      try {
        if (!prevOutlines.has(mNode)) prevOutlines.set(mNode, mNode.style.outline || '');
        mNode.style.outline = STYLE_LIST_MATCH;
        mNode.style.background = STYLE_LIST_MATCH_BG;
      } catch (_) {}
      listMatchNodes.push(mNode);
    }
    var text = (pickedNode.innerText || pickedNode.textContent || '').trim().slice(0, 200);
    var html = (pickedNode.outerHTML || '').slice(0, 400);
    // Full innerText length + a larger outerHTML slice: the parent uses these
    // to decide whether this is an article-BODY field (long text) and, if so,
    // to ask the backend for a cleaner body selector + paywall flag.
    var fullTextLen = (pickedNode.innerText || pickedNode.textContent || '').trim().length;
    var htmlFull = (pickedNode.outerHTML || '').slice(0, 12000);

    // ── REFINE — if we currently have an AI Magic highlight up, compute
    // the longest-common-ancestor selector between the picked element
    // and the first highlighted node. The parent uses this for the
    // "blue" 3rd-tier refinement layer (cheap, no LLM call).
    var refinedFromHighlight = null;
    if (highlightedNodes.length > 0) {
      var anchor = highlightedNodes[0];
      var lcaNode = lowestCommonAncestor(anchor, pickedNode);
      if (lcaNode && lcaNode !== document.body && lcaNode !== document.documentElement) {
        refinedFromHighlight = {
          selector: computeSelector(lcaNode, 'list'),  // list-style: catch siblings
          why: 'LCA of AI candidate and the element you just clicked'
        };
      }
    }

    send({
      type: 'webrobot-pick-selector',
      selector: selector,
      mode: selMode,
      matches: matches,
      sampleText: text,
      sampleHtml: html,
      sampleHtmlFull: htmlFull,
      fullTextLen: fullTextLen,
      refinedFromHighlight: refinedFromHighlight,
      attributes: elementAttrNames(pickedNode)
    });
  }, true);

  function lowestCommonAncestor(a, b) {
    if (!a || !b) return null;
    var ancestors = [];
    var x = a;
    while (x) { ancestors.push(x); x = x.parentElement; }
    var setA = new Set(ancestors);
    var y = b;
    while (y) { if (setA.has(y)) return y; y = y.parentElement; }
    return null;
  }

  // ── 5. Action mode: keystrokes → Type(selector, text) ──────────────
  // Accumulate typed characters per target so a "type 'Hello'" comes out
  // as a single Type action, not 5 separate keystrokes.
  function flushPendingType() {
    if (!lastInputTarget) return;
    var val = lastInputTarget.value || '';
    var pushed = false;
    if (val) {
      actions.push({ type: 'Type', selector: computeSelector(lastInputTarget, 'single'), text: val });
      pushed = true;
    }
    lastInputTarget = null;
    // Notify the parent so the "Send (N)" button count includes Types
    // that the user committed by leaving the field (idle flush) instead
    // of clicking somewhere else.
    if (pushed) {
      refreshBanner();
      send({ type: 'webrobot-pick-actions', actions: actions });
    }
  }
  document.addEventListener('input', function (e) {
    if (mode !== 'action-record') return;
    if (e.target === banner || banner.contains(e.target)) return;
    var t = e.target;
    if (t !== lastInputTarget) {
      flushPendingType();
      lastInputTarget = t;
    }
    lastInputTime = Date.now();
  }, true);
  // Periodic flush so leaving a field commits its Type.
  setInterval(function () {
    if (mode !== 'action-record') return;
    if (lastInputTarget && Date.now() - lastInputTime > 1500) flushPendingType();
  }, 1000);

  // ── 6. Action mode: scroll → REMOVED ─────────────────────────────
  // We used to record every 1-second window of scrolling as a Scroll
  // action. On any moderately-long ecommerce listing that pumped
  // dozens of useless Scroll entries into the batch — each one a
  // round-trip to Camoufox at Send time — and crowded the YAML trace.
  // The runtime auto-scrolls into view when a later step targets an
  // off-screen selector (Playwright's actionability checks do this),
  // so a user-driven trace doesn't need explicit Scroll actions to
  // be replayable. Drop them entirely from the auto-recorder; if a
  // user needs an explicit pause/scroll they can add Wait(ms) by
  // editing the trace block in the YAML preview after Apply.

  // ── 7. Page navigation (action mode) ──────────────────────────────
  // We tell the parent so it can decide to keep the run going (the
  // proxied page reloads under the same iframe).
  window.addEventListener('beforeunload', function () {
    if (mode === 'action-record') {
      flushPendingType();
      send({ type: 'webrobot-picker-navigation', actions: actions });
    }
  });

  // ── 8. ESC ─────────────────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (mode === 'action-record') {
        flushPendingType();
        send({ type: 'webrobot-pick-actions', actions: actions });
        actions = [];
        refreshBanner();
      } else {
        send({ type: 'webrobot-picker-cancel' });
      }
    }
  }, true);

  // ── 9. CSS selector inference ──────────────────────────────────────
  // Single mode: append :nth-of-type to disambiguate among siblings.
  // Attribute names present on the picked element, for the wizard's
  // "method" dropdown (attr:<name>). Skips display/noise attrs (class,
  // style, inline on* handlers) and dedups. The host maps these to
  // attr:href / attr:src / attr:data-… extractor options so the user can
  // pull a specific attribute instead of just text/html.
  function elementAttrNames(el) {
    var names = [];
    try {
      if (el && el.attributes) {
        for (var i = 0; i < el.attributes.length; i++) {
          var n = el.attributes[i].name;
          if (!n) continue;
          if (n === 'class' || n === 'style') continue;
          if (n.indexOf('on') === 0) continue;            // onclick, onload, …
          if (names.indexOf(n) === -1) names.push(n);
        }
      }
    } catch (_) {}
    return names;
  }

  // List mode:   skip :nth-of-type so the same selector catches every
  //              sibling (cards, rows, items).
  // Lowest common ancestor of two elements (or null). Used by row-lca mode to
  // find the repeating row container that wraps two separately-clicked parts.
  function commonAncestor(a, b) {
    var anc = [];
    var n = a;
    while (n && n.nodeType === 1) { anc.push(n); n = n.parentElement; }
    n = b;
    while (n && n.nodeType === 1) { if (anc.indexOf(n) !== -1) return n; n = n.parentElement; }
    return null;
  }

  function computeSelector(el, selMode) {
    if (!el || el === document.body || el === document.documentElement) {
      return el && el.tagName ? el.tagName.toLowerCase() : 'body';
    }
    var path = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 8) {
      var part = node.tagName.toLowerCase();
      var id = node.id;
      // Skip the `#id` short-circuit in 'list' mode — that mode is
      // meant to produce a class-pattern selector that catches
      // siblings across rows. On listing pages (eBay, Bazaraki, …)
      // each row carries an auto-generated id like #item3bf6223e6d;
      // anchoring on it would lock the selector to ONE row even
      // though the rest of the chain would otherwise generalise.
      // 'single' mode still uses the id for tight uniqueness.
      if (selMode !== 'list' && id && /^[A-Za-z][\w-]*$/.test(id) && !looksHashed(id)) {
        path.unshift('#' + id);
        break;
      }
      var classes = (typeof node.className === 'string' ? node.className : '')
        .split(/\s+/).filter(stableClass);
      if (classes.length > 0) part += '.' + classes.slice(0, 3).join('.');

      if (selMode !== 'list') {
        var parent = node.parentElement;
        if (parent) {
          var sameTag = Array.prototype.filter.call(
            parent.children,
            function (c) { return c.tagName === node.tagName; }
          );
          if (sameTag.length > 1) {
            var idx = sameTag.indexOf(node) + 1;
            part += ':nth-of-type(' + idx + ')';
          }
        }
      }
      path.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return path.join(' > ');
  }

  // Compute a CSS path from `ancestor` (exclusive) down to `el` so that
  // ancestor.querySelector(returned) === el. Used in multi-field mode
  // when a flatSelect segment container is set — the runtime applies
  // each field selector inside each segment match.
  // ── Generic-first relative selector for multi-field flatSelect ────
  // Build a tag.class chain from `el` up to `ancestor` WITHOUT any
  // :nth-of-type segments. The intent is to produce a selector that
  // naturally matches the same logical column across every container
  // match — so a single click on the price span in row 1 already
  // highlights the price span in EVERY row, no second-click needed.
  //
  // If the resulting selector overshoots (matches 2+ elements within
  // a single container) the caller should fall back to the strict
  // computeSelectorRelativeTo + autoRelaxRelativeSelector path; that
  // adds back enough :nth-of-type segments to disambiguate while
  // keeping per-container hit count = 1.
  function computeRelativeSelectorGeneric(el, ancestor) {
    if (!el || !ancestor) return computeSelector(el, 'list');
    var chain = [];
    var node = el;
    var depth = 0;
    while (node && node !== ancestor && depth < 10) {
      var part = node.tagName ? node.tagName.toLowerCase() : '';
      // INTENTIONALLY skip the `#id` short-circuit. eBay-style sites
      // give every row a unique auto-generated id (e.g. #item3bf6223e6d)
      // — anchoring on it locks the selector to ONE row and defeats
      // cross-row generalisation. The container selector handles
      // per-row identity; the relative selector should be class-based.
      var classes = (typeof node.className === 'string' ? node.className : '')
        .split(/\s+/).filter(stableClass);
      if (classes.length > 0) part += '.' + classes.slice(0, 3).join('.');
      // INTENTIONALLY no :nth-of-type — the goal is a class-pattern
      // selector that catches the same element in every row.
      chain.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return chain.join(' > ');
  }

  function computeSelectorRelativeTo(el, ancestor) {
    if (!el || !ancestor) return computeSelector(el, 'single');
    var chain = [];
    var node = el;
    var depth = 0;
    while (node && node !== ancestor && depth < 10) {
      var part = node.tagName ? node.tagName.toLowerCase() : '';
      var id = node.id;
      if (id && /^[A-Za-z][\w-]*$/.test(id) && !looksHashed(id)) {
        chain.unshift('#' + id);
        break;
      }
      var classes = (typeof node.className === 'string' ? node.className : '')
        .split(/\s+/).filter(stableClass);
      if (classes.length > 0) part += '.' + classes.slice(0, 3).join('.');
      var parent = node.parentElement;
      if (parent && parent !== ancestor) {
        var sameTag = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (sameTag.length > 1) {
          var idx = sameTag.indexOf(node) + 1;
          part += ':nth-of-type(' + idx + ')';
        }
      }
      chain.unshift(part);
      node = parent;
      depth++;
    }
    return chain.join(' > ');
  }

  function stableClass(c) {
    if (!c) return false;
    if (c.length > 40) return false;
    if (looksHashed(c)) return false;
    if (/^(?:active|hover|focus|disabled|selected)$/i.test(c)) return false;
    return /^[A-Za-z_][\w-]*$/.test(c);
  }
  function looksHashed(s) {
    if (!s) return false;
    // Pure-hex blob: ab12cd34ef
    if (/^[a-f0-9]{6,}$/i.test(s)) return true;
    // CSS-module-style triple-segment: btn-x4f9a-3b2c
    if (/[a-z]{1,4}-[a-z0-9]{4,}-[a-z0-9]{4,}/i.test(s)) return true;
    // Short alpha prefix + long hex/digit suffix: item3bf6223e6d, srp1234567890,
    // productab12cd34 — eBay / Amazon / generic-CMS auto-generated row IDs.
    // The suffix must look like hex (or pure-digit) AND be long enough
    // (>=8 chars) that it can't be a meaningful semantic suffix like
    // 'btn1' or 'col12'.
    if (/^[a-z]{1,6}[0-9a-f]{8,}$/i.test(s)) return true;
    // Alpha prefix + underscore/dash + hex blob: item_3bf6223e6d, sku-ab12cd34
    if (/^[a-z]+[_-][0-9a-f]{8,}$/i.test(s)) return true;
    return false;
  }

  // ── Multi-sample helpers ──────────────────────────────────────────
  // Build a "tag.class.class" path piece for each ancestor of el, leaf
  // first, stopping at <body>. Same shape as computeSelector('list')
  // but returned as an array instead of " > "-joined for easier
  // intersection across multiple samples.
  function pathPieces(el) {
    var pieces = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 8) {
      var part = node.tagName.toLowerCase();
      var classes = (typeof node.className === 'string' ? node.className : '')
        .split(/\s+/).filter(stableClass);
      if (classes.length > 0) part += '.' + classes.slice(0, 3).join('.');
      pieces.push(part); // leaf at index 0
      node = node.parentElement;
      depth++;
    }
    return pieces;
  }

  // Intersect piece arrays level-by-level (same tag required, classes
  // narrowed to the intersection). Returns the intersected piece, or
  // null if the tags don't match — in that case the suffix stops here.
  function intersectPiece(pieces) {
    if (!pieces.length) return null;
    var firstTag = pieces[0].split('.')[0];
    for (var i = 1; i < pieces.length; i++) {
      if (pieces[i].split('.')[0] !== firstTag) return null;
    }
    var classSets = pieces.map(function (p) {
      return p.split('.').slice(1);
    });
    var common = classSets[0].slice();
    for (var i = 1; i < classSets.length; i++) {
      common = common.filter(function (c) { return classSets[i].indexOf(c) !== -1; });
    }
    return firstTag + (common.length ? '.' + common.join('.') : '');
  }

  // Given N sample elements, return the most-specific selector that
  // matches ALL of them, and the total match count. Strategy: take the
  // longest common right-suffix of (intersected) path pieces, then try
  // selectors of decreasing suffix length until one matches every
  // sample via querySelectorAll.
  function computeCommonListSelector(samples) {
    if (!samples || samples.length === 0) return null;
    if (samples.length === 1) {
      // Single-sample path: the initial chain may include classes that
      // are SPECIFIC to this one row variant (e.g. .s-card--sponsored
      // on the featured ad in an eBay SRP), so it would match only
      // that single element. Relax progressively until we find a
      // selector that still includes the seed but matches 2+ siblings
      // — the sample is, by user intent, "any row that LOOKS LIKE
      // this one", so a 1-match result is a UX failure.
      var seed = samples[0];
      var oneSel = computeSelector(seed, 'list');
      var oneMatched = document.querySelectorAll(oneSel);
      // Easy path: chain already generalises.
      if (oneMatched.length > 1) {
        return { selector: oneSel, matches: oneMatched.length };
      }
      // Relax 1 — drop leaf class tokens one at a time, deepest first.
      // pathPieces() returns ["leaf.class.class", "parent.class", ...]
      // (leaf at index 0). Walk the chain and rebuild it with FEWER
      // classes on the leaf until match count climbs above 1.
      var pieces = pathPieces(seed);                 // leaf-first
      var rootFirst = pieces.slice().reverse();      // root-first
      // Try dropping classes from the leaf, then progressively higher.
      for (var depth = 0; depth < rootFirst.length; depth++) {
        // rebuilt with N classes stripped from the depth-th piece
        var idx = rootFirst.length - 1 - depth; // matches pieces[depth]
        var piece = rootFirst[idx];
        var parts = piece.split('.');
        var tag = parts[0];
        var classes = parts.slice(1);
        // Drop classes one at a time, longest-first (most likely to be
        // the per-row variant class).
        var sortedClasses = classes.slice().sort(function (a, b) { return b.length - a.length; });
        for (var drop = 1; drop <= sortedClasses.length; drop++) {
          var keep = sortedClasses.slice(drop);
          var newPiece = tag + (keep.length ? '.' + keep.join('.') : '');
          var rebuilt = rootFirst.slice();
          rebuilt[idx] = newPiece;
          var candidate = rebuilt.join(' > ');
          try {
            var hits = document.querySelectorAll(candidate);
            if (hits.length > 1) {
              var found = Array.prototype.slice.call(hits);
              if (found.indexOf(seed) !== -1) {
                return { selector: candidate, matches: found.length };
              }
            }
          } catch (_) {}
        }
      }
      // Relax 2 — try the leaf with just its tag (no classes) so we
      // still target the SAME node depth (still a "row"), not the
      // parent. Walking up the chain would change the semantic from
      // "the repeating row" to "the wrapper containing the rows" and
      // then the field selectors computed inside the wrapper would
      // include the row tag in their relative path — exactly the
      // bug reported on flatSelect: "field selector includes the row
      // selector together with the field path".
      var leafOriginal = rootFirst[rootFirst.length - 1];
      var leafTag = leafOriginal.split('.')[0];
      var leafOnly = rootFirst.slice();
      leafOnly[leafOnly.length - 1] = leafTag;
      var leafOnlySel = leafOnly.join(' > ');
      try {
        var leafHits = document.querySelectorAll(leafOnlySel);
        if (leafHits.length > 1) {
          var leafFound = Array.prototype.slice.call(leafHits);
          if (leafFound.indexOf(seed) !== -1) {
            return { selector: leafOnlySel, matches: leafFound.length };
          }
        }
      } catch (_) {}
      // Give up: return the original (1-match) selector so the host
      // still sees the user's intent. Walking up to the wrapper would
      // misalign the row level and break per-row field selectors.
      console.debug('[picker.js] computeCommonListSelector: single sample never reached >1 match, falling back to original',
                    oneSel);
      return { selector: oneSel, matches: oneMatched.length };
    }
    var paths = samples.map(pathPieces);
    var maxCommon = Math.min.apply(null, paths.map(function (p) { return p.length; }));
    var common = []; // leaf-first
    for (var d = 0; d < maxCommon; d++) {
      var levelPieces = paths.map(function (p) { return p[d]; });
      var inter = intersectPiece(levelPieces);
      if (inter == null) break;
      common.push(inter);
    }
    // Try selectors of decreasing length: prefer the longest (most
    // specific) selector that still matches every clicked sample.
    for (var n = common.length; n >= 1; n--) {
      var sub = common.slice(0, n).slice().reverse(); // root-first
      var sel = sub.join(' > ');
      try {
        var foundNL = document.querySelectorAll(sel);
        // querySelectorAll returns a static NodeList; convert to Array
        // once so the every() check below stays O(N).
        var found = Array.prototype.slice.call(foundNL);
        var ok = samples.every(function (s) { return found.indexOf(s) !== -1; });
        if (ok) return { selector: sel, matches: found.length };
      } catch (_) {}
    }
    // UNION fallback: the samples share no common path (heterogeneous rows —
    // e.g. two different card variants, or Reddit posts with per-type
    // classes). Instead of giving up, OR-join each sample's own list-style
    // selector: `selA, selB` matches every instance of BOTH types. Dedup the
    // per-sample selectors so identical ones don't bloat the union.
    return unionListSelector(samples);
  }

  // Build a comma-separated (CSS union) selector from the samples' individual
  // list-style selectors. Used when intersection finds nothing in common.
  function unionListSelector(samples) {
    var parts = [];
    for (var i = 0; i < samples.length; i++) {
      var s = computeSelector(samples[i], 'list');
      if (s && parts.indexOf(s) === -1) parts.push(s);
    }
    if (!parts.length) return null;
    var union = parts.join(', ');
    var matches = 0;
    try { matches = document.querySelectorAll(union).length; } catch (_) { return null; }
    console.debug('[picker.js] no common selector → union fallback:', union,
                  '(' + matches + ' matches, ' + parts.length + ' variants)');
    return { selector: union, matches: matches };
  }

  // Highlight every element matched by the candidate selector. The
  // seed elements (the ones the user actually clicked) get a stronger
  // outline so they're distinguishable from the inferred matches.
  function applyMultiSampleHighlight(selector) {
    if (!multiSampleStyleEl) {
      multiSampleStyleEl = document.createElement('style');
      multiSampleStyleEl.textContent =
        '.__wr_multi_sample{outline:2px solid #43a047!important;outline-offset:1px;' +
        'background:rgba(67,160,71,0.10)!important;}' +
        '.__wr_multi_sample_seed{outline:3px solid #1565c0!important;}';
      document.head.appendChild(multiSampleStyleEl);
    }
    // Drop old classes wholesale.
    document.querySelectorAll('.__wr_multi_sample,.__wr_multi_sample_seed').forEach(function (n) {
      n.classList.remove('__wr_multi_sample');
      n.classList.remove('__wr_multi_sample_seed');
    });
    if (selector) {
      try {
        var matched = document.querySelectorAll(selector);
        for (var i = 0; i < matched.length; i++) matched[i].classList.add('__wr_multi_sample');
      } catch (_) {}
    }
    for (var i = 0; i < multiSampleNodes.length; i++) {
      multiSampleNodes[i].classList.add('__wr_multi_sample_seed');
    }
  }

  // ── Multi-field cross-row highlight ───────────────────────────────
  // When the container selector is set, apply the relative selector
  // ── Row-number badges over flatSelect container matches ─────────────
  // Visual hint while picking fields: each row gets a small "#N" badge
  // in its top-left corner so the user can see how many rows the
  // segmentSelector currently matches AND which row they're hovering.
  // Idempotent — skips containers that already have a badge. Called on:
  //  - multi-config message (initial paint)
  //  - every field-pick (in case lazy-loaded rows appeared mid-recording)
  function clearRowNumberBadges() {
    document.querySelectorAll('.__wr_row_badge').forEach(function (b) {
      try { b.remove(); } catch (_) {}
    });
  }
  // Soft outline applied to every row matching multiContainerSelector
  // so the user can see the SCOPE before clicking anything. Kept dashed
  // and blue to distinguish from the green field-pick outline + red
  // out-of-container hover guard. Tracked separately from prevOutlines
  // so we can clear/repaint without colliding with field highlights.
  var preSelectedRows = [];
  function clearRowPreSelectOutlines() {
    preSelectedRows.forEach(function (n) {
      try {
        n.style.outline = '';
        n.style.background = '';
      } catch (_) {}
    });
    preSelectedRows = [];
  }
  function paintRowNumbers() {
    clearRowNumberBadges();
    clearRowPreSelectOutlines();
    if (!multiContainerSelector) return;
    var rows = [];
    try { rows = document.querySelectorAll(multiContainerSelector); } catch (_) { return; }
    console.debug('[picker.js] paintRowNumbers: containerSelector=', multiContainerSelector,
                  'matched rows=', rows.length);
    // Tell the parent how many rows are in scope. The wizard surfaces
    // this as "Tracking N rows" so the user can confirm the row
    // selector before picking fields.
    try {
      send({ type: 'webrobot-picker-multi-rows', count: rows.length,
             containerSelector: multiContainerSelector });
    } catch (_) {}
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      try {
        // The badge needs to be absolutely positioned relative to the row.
        // Force position:relative on the container if it's static — otherwise
        // the badge would anchor to the nearest positioned ancestor (usually
        // the viewport) and float in the wrong place.
        var cs = window.getComputedStyle(row);
        if (cs.position === 'static') row.style.position = 'relative';
        var badge = document.createElement('span');
        badge.className = '__wr_row_badge';
        badge.textContent = '#' + (i + 1);
        badge.style.cssText =
          'position:absolute;top:0;left:0;z-index:2147483646;' +
          'background:#111;color:#fff;font:600 10px/1 system-ui,sans-serif;' +
          'padding:3px 6px;border-radius:0 0 6px 0;pointer-events:none;' +
          'box-shadow:0 1px 4px rgba(0,0,0,.25);';
        row.appendChild(badge);
        // Pre-select outline so the user sees IMMEDIATELY which DOM
        // regions are in scope — without having to click anything.
        // Seed prevOutlines too so the hover overlay restores back to
        // this soft blue when the cursor leaves (same trick we use for
        // field highlights).
        row.style.outline = '2px dashed #2196f3';
        row.style.background = 'rgba(33,150,243,0.05)';
        try { prevOutlines.set(row, '2px dashed #2196f3'); } catch (_) {}
        preSelectedRows.push(row);
      } catch (_) {}
    }
  }

  // ── Auto-relax a per-field relative selector ─────────────────────────
  // Issue: computeSelectorRelativeTo can append :nth-of-type(N) to disambiguate
  // siblings of same tag — fine for unique IDs, problematic for "every row has
  // a price in slot 3" cases because the result matches only THAT row's price.
  // We post-process: if the relSel hits fewer rows than there are container
  // matches, iteratively drop the rightmost :nth-of-type(...) and re-check.
  // Stop on first relaxation that increases hits but doesn't OVERSHOOT (i.e.
  // doesn't start matching multiple elements within a single row — which
  // would mean we lost too much specificity).
  function countMatchesPerContainer(relSel) {
    var hits = 0, overshoots = 0;
    if (!multiContainerSelector || !relSel) return { hits: 0, overshoots: 0, containers: 0 };
    var containers = [];
    try { containers = document.querySelectorAll(multiContainerSelector); } catch (_) {}
    for (var i = 0; i < containers.length; i++) {
      var matches;
      try { matches = containers[i].querySelectorAll(relSel); } catch (_) { matches = []; }
      if (matches.length >= 1) hits++;
      if (matches.length > 1)  overshoots++;
    }
    return { hits: hits, overshoots: overshoots, containers: containers.length };
  }
  function autoRelaxRelativeSelector(relSel) {
    if (!multiContainerSelector || !relSel) return relSel;
    var stats = countMatchesPerContainer(relSel);
    if (stats.hits >= stats.containers) return relSel; // already covers all rows
    var current = relSel;
    // Strip :nth-of-type(N) from RIGHT (deepest first), then re-test.
    while (/:nth-of-type\(\d+\)/.test(current)) {
      var relaxed = current.replace(/:nth-of-type\(\d+\)(?=[^:]*$)/, '');
      // Normalise extra whitespace introduced by removal
      relaxed = relaxed.replace(/\s+>\s+/g, ' > ').trim();
      if (relaxed === current) break;
      var s = countMatchesPerContainer(relaxed);
      if (s.hits > stats.hits && s.overshoots === 0) {
        current = relaxed; stats = s;
        if (s.hits >= s.containers) break;       // covers all → done
      } else if (s.overshoots > 0) {
        break;                                   // too loose, would match 2+ per row
      } else {
        // No improvement — try stripping another :nth anyway
        current = relaxed;
      }
    }
    return current;
  }

  // inside EVERY container match and outline each hit so the user sees
  // the column across all rows. Returns the list of styled nodes so
  // callers can later clear them.
  function applyMultiFieldHighlight(relSel, color, containerSel) {
    var styled = [];
    if (!relSel) return styled;
    try {
      if (containerSel) {
        var containers = document.querySelectorAll(containerSel);
        for (var ci = 0; ci < containers.length; ci++) {
          // querySelector inside the container; relative selectors don't
          // need :scope here because the path was computed via
          // computeSelectorRelativeTo and is naturally container-rooted.
          var hit = null;
          try { hit = containers[ci].querySelector(relSel); } catch (_) {}
          if (hit) {
            try { hit.style.outline = '3px solid ' + color; hit.style.background = color + '22'; } catch (_) {}
            styled.push(hit);
          }
        }
      } else {
        var all = document.querySelectorAll(relSel);
        for (var i = 0; i < all.length; i++) {
          try { all[i].style.outline = '3px solid ' + color; all[i].style.background = color + '22'; } catch (_) {}
          styled.push(all[i]);
        }
      }
    } catch (_) {}
    return styled;
  }

  function clearMultiSampleHighlights() {
    document.querySelectorAll('.__wr_multi_sample,.__wr_multi_sample_seed').forEach(function (n) {
      n.classList.remove('__wr_multi_sample');
      n.classList.remove('__wr_multi_sample_seed');
    });
  }

  // ── ANTI-BOT MODE: full event capture + auto-detect ──────────────
  // Mirror of the server-side CaptchaDetector heuristic, run client-side
  // every 2s while in action-record mode. On detect, flip to anti-bot
  // capture and tell the parent so it can mark the pipeline as
  // requires_hitl + warn the user.
  function detectAntiBotIndicators() {
    try {
      function has(sel) { try { return !!document.querySelector(sel); } catch (_) { return false; } }
      var txt = (document.title + ' ' + (document.body ? document.body.innerText : '')).toLowerCase();
      if (has('iframe[src*="hcaptcha.com"]') || has('[data-hcaptcha-widget-id]')) return 'hcaptcha';
      if (has('iframe[src*="recaptcha"]') || has('.g-recaptcha'))                  return 'recaptcha';
      if (has('iframe[src*="challenges.cloudflare.com"]') || has('#cf-challenge-running') || has('#challenge-form')) return 'cloudflare';
      if (has('iframe[src*="datadome"]') || has('#captcha__puzzle'))               return 'datadome';
      if (has('#px-captcha') || has('iframe[src*="px-cdn"]') || has('iframe[src*="perimeterx"]')) return 'perimeterx';
      if (/(just a moment|verify you are human|are you a robot|access denied|please complete the security check|sorry, we just need to make sure|robot or human)/i.test(txt)) return 'interstitial-text';
    } catch (_) {}
    return null;
  }

  function enableAntiBotMode(reason) {
    if (antiBotMode) return;
    antiBotMode    = true;
    antiBotStartTs = performance.now();
    // antiBotActive() requires mode==='action-record' for the raw-event
    // listeners to fire. If we got here via the 2s auto-detector while
    // the user is in a SELECTOR mode (or just landed on the page in
    // single-pick), the listeners would be no-op and the trace would
    // stay empty even though events are happening. Force-switch the
    // local mode so the listeners are gated correctly the next tick,
    // and inform the parent so its UI tab also flips.
    if (mode !== 'action-record') {
      mode = 'action-record';
      send({ type: 'webrobot-picker-mode-forced', mode: 'action-record', reason: 'anti-bot-auto-enable' });
    }
    refreshBanner();
    send({ type: 'webrobot-picker-anti-bot-detected', reason: reason, ts: Date.now() });
  }
  function disableAntiBotMode() {
    if (!antiBotMode) return;
    antiBotMode = false;
    refreshBanner();
  }

  // Periodic detector — runs only in action-record mode to avoid noise
  // when the user is just picking selectors. ~2s cadence is sensible:
  // fast enough to catch a Cloudflare interstitial that mounts after
  // the click, slow enough not to thrash the DOM.
  setInterval(function () {
    if (mode !== 'action-record') return;
    if (antiBotMode) return; // already flipped, don't re-fire
    var hit = detectAntiBotIndicators();
    if (hit) {
      console.log('[picker.js] anti-bot detected:', hit);
      enableAntiBotMode(hit);
    }
  }, 2000);

  // Listen for parent override (user manually toggling, or restoring
  // anti-bot mode on a re-opened session).
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'webrobot-picker-anti-bot-mode') {
      if (d.enabled) enableAntiBotMode(d.reason || 'user-toggled');
      else           disableAntiBotMode();
    }
  });

  // Raw event capture. All listeners are no-op unless antiBotMode is on
  // and mode==='action-record' — keep them registered always so we don't
  // race the user enabling the mode after they already moved the mouse.
  function antiBotActive() {
    return antiBotMode && mode === 'action-record';
  }
  function bufferRaw(type, payload) {
    if (!antiBotActive()) return;
    var t = performance.now() - antiBotStartTs;
    actions.push(Object.assign({ type: type, t_ms: Math.round(t) }, payload));
    // Tell parent the count changed so the Send (N) badge updates.
    // Throttle to avoid thousands of postMessages for mousemove streams.
    if (type !== 'MouseMove' || actions.length % 25 === 0) {
      send({ type: 'webrobot-pick-actions', actions: actions });
    }
  }
  document.addEventListener('mousemove', function (e) {
    if (!antiBotActive()) return;
    // Throttle mousemove to ~60fps max to keep buffer manageable —
    // executor still gets enough points to reconstruct the curve.
    var now = performance.now();
    if (now - antiBotLastMove < 16) return;
    antiBotLastMove = now;
    bufferRaw('MouseMove', { x: Math.round(e.clientX), y: Math.round(e.clientY) });
  }, { capture: true, passive: true });
  document.addEventListener('mousedown', function (e) {
    if (!antiBotActive()) return;
    bufferRaw('MouseDown', {
      x: Math.round(e.clientX), y: Math.round(e.clientY),
      button: e.button   // 0=left, 1=middle, 2=right
    });
  }, { capture: true });
  document.addEventListener('mouseup', function (e) {
    if (!antiBotActive()) return;
    bufferRaw('MouseUp', {
      x: Math.round(e.clientX), y: Math.round(e.clientY),
      button: e.button
    });
  }, { capture: true });
  document.addEventListener('wheel', function (e) {
    if (!antiBotActive()) return;
    bufferRaw('Wheel', { dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
  }, { capture: true, passive: true });
  document.addEventListener('keydown', function (e) {
    if (!antiBotActive()) return;
    if (e.target === banner || banner.contains(e.target)) return;
    bufferRaw('KeyDown', { key: e.key });
  }, { capture: true });
  document.addEventListener('keyup', function (e) {
    if (!antiBotActive()) return;
    if (e.target === banner || banner.contains(e.target)) return;
    bufferRaw('KeyUp', { key: e.key });
  }, { capture: true });
  document.addEventListener('scroll', function () {
    if (!antiBotActive()) return;
    bufferRaw('Scroll', { y: Math.round(window.scrollY) });
  }, { capture: true, passive: true });

  send({ type: 'webrobot-picker-ready' });
})();
