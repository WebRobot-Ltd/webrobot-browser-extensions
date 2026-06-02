<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  catalogStages, getToken, setToken, startPicker, onPick, sendToPicker,
  inferSegment, inferSelector, inferFields, inferOddsStructure, suggestFieldNames,
  relaxSelectors, validatePipeline, saveGeneratedPipeline,
  executionStatus, executionLogs, executionOutput, currentUrl, pageHtml,
  runTrace, highlight, recStart, recStop,
} from './api.js'

/* WebRobot Pipeline Designer — browser-extension port of DemoApp.vue.
   Full picker (single / multi-field / multi-sample / row-lca / action-record /
   generalize) + AI Magic (infer-selector / infer-segment / infer-fields /
   infer-odds-structure / relax / suggest-names) over the content-script
   transport. Camoufox stays the runtime; picking is on the REAL page. */

// ── mode + auth ──
// Demo = public sandbox (auto demo JWT in the background, NO key needed).
// Production = your account / BYOC subscription — coming soon (disabled).
const mode = ref('demo')
const token = ref('')
const status = ref('')
async function saveToken() { await setToken(token.value); status.value = token.value ? 'Key saved.' : 'Key cleared (demo auto-auth).' }
// Future: redirect to the subscription / BYOC plans page. Disabled until plans
// go live; for now Production mode only shows the "coming soon" notice.
function openPlans() { /* TODO: ext.tabs.create({url: 'https://www.webrobot.eu/pricing'}) when plans ship */ }

// ── catalog ──
const stages = ref([])
const search = ref('')
const loadingCatalog = ref(false)
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return stages.value
  return stages.value.filter(s => (s.stage_name || '').toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q))
})
async function loadCatalog() {
  loadingCatalog.value = true; status.value = 'Loading stage catalog…'
  try {
    const res = await catalogStages()
    stages.value = (res && res.data) ? res.data : (Array.isArray(res) ? res : [])
    status.value = `Loaded ${stages.value.length} stages.`
  } catch (e) { status.value = 'Catalog error: ' + e.message } finally { loadingCatalog.value = false }
}
const specFor = (n) => stages.value.find(s => s.stage_name === n || (s.aliases || []).includes(n))
const argSchema = (n) => (specFor(n) || {}).arg_schema || []

// ── pipeline ──
const pipeline = ref([])
const wizName = ref('extension-pipeline')
function addStage(s) { pipeline.value.push({ stage_name: s.stage_name, args: {}, _fields: [], _markets: [], _trace: [], _aiIntent: '', _aiBox: null }) }
function removeStage(i) { pipeline.value.splice(i, 1) }
function moveStage(i, d) { const j = i + d; if (j < 0 || j >= pipeline.value.length) return; const a = pipeline.value;[a[i], a[j]] = [a[j], a[i]]; pipeline.value = [...a] }
const touch = () => { pipeline.value = [...pipeline.value] }
const isStructured = (n) => n === 'extract' || n === 'flatSelect'
const isOdds = (n) => n === 'oddsSelect' || n === 'odds_select'
const FETCH_LIKE = new Set(['fetch', 'visit', 'wget', 'wgetExplore', 'visitExplore', 'explore', 'wgetJoin', 'visitJoin'])
function segArgName(row) { const sch = argSchema(row.stage_name); return (sch.find(a => /segment|selector/i.test(a.name)) || {}).name || 'segmentSelector' }
function urlArgName(row) { const sch = argSchema(row.stage_name); return (sch.find(a => /url|uri/i.test(a.name)) || {}).name || 'url' }

// ── settings ──
const wizGeo = ref('')
const wizRuntime = ref('spark')
const GEO_ZONES = [
  { code: '', label: '🌍 Auto' }, { code: 'gb', label: '🇬🇧 UK' }, { code: 'it', label: '🇮🇹 Italy' },
  { code: 'de', label: '🇩🇪 Germany' }, { code: 'fr', label: '🇫🇷 France' }, { code: 'es', label: '🇪🇸 Spain' },
  { code: 'us', label: '🇺🇸 USA' }, { code: 'nl', label: '🇳🇱 NL' },
]

// ── editing ──
function updateArg(i, n, v) { pipeline.value[i].args[n] = v; touch() }
function addField(i) { (pipeline.value[i]._fields ||= []).push({ selector: '', as: 'field', method: 'text' }); touch() }
function updField(i, fi, k, v) { pipeline.value[i]._fields[fi][k] = v; touch() }
function rmField(i, fi) { pipeline.value[i]._fields.splice(fi, 1); touch() }
function addMarketField(i, mi) { (pipeline.value[i]._markets[mi].fields ||= []).push({ selector: '', as: 'field', method: 'text' }); touch() }
function updMarket(i, mi, k, v) { pipeline.value[i]._markets[mi][k] = v; touch() }
function updMarketField(i, mi, fi, k, v) { pipeline.value[i]._markets[mi].fields[fi][k] = v; touch() }
function rmMarket(i, mi) { pipeline.value[i]._markets.splice(mi, 1); touch() }
function setIntent(i, v) { pipeline.value[i]._aiIntent = v }
function clearTrace(i) { pipeline.value[i]._trace = []; touch() }
function rmTrace(i, ai) { pipeline.value[i]._trace.splice(ai, 1); touch() }

// ── picker binding ──
const pt = ref(null)             // { stageIdx, kind, argName }
const recording = ref(null)      // stageIdx currently recording a trace
const traceStage = ref(null)     // stage to route webrobot-pick-actions to (survives pt reset)
let pickTab = null, stopPick = null
const oddsInferKey = ref(null), aiBusy = ref(false)

async function beginPick(target, mode) {
  pt.value = target
  try {
    pickTab = await startPicker(mode); status.value = `Picker (${mode}) — interact on the page.`
    // Clear any stale row/link highlights so hovering is clean during this pick.
    try { await sendToPicker(pickTab, { type: 'webrobot-picker-multi-clear' }) } catch (_) {}
    await sendMultiConfig(null)
  }
  catch (e) { status.value = 'Picker error: ' + e.message }
}
// Tell the picker to STOP intercepting (so links navigate + Replay works).
async function deactivatePicker() {
  try { await sendToPicker(pickTab, { type: 'webrobot-picker-mode', mode: 'off' }) } catch (_) {}
  pt.value = null
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
// Link-following stages: their main selector matches a repeating LINK — like a
// flatSelect segment, we highlight ALL matches so the user sees the set.
const LINK_STAGES = new Set(['explore', 'join', 'visitExplore', 'wgetExplore', 'visitJoin', 'wgetJoin'])
function isHighlightArg(row, name) {
  return (row.stage_name === 'flatSelect' && name === segArgName(row)) ||
         (LINK_STAGES.has(row.stage_name) && /selector/i.test(name))
}
// Tell the picker to outline every match of `sel` (+ row badges). Same channel
// flatSelect uses in the demo app (paintRowNumbers).
async function sendMultiConfig(sel) { try { await sendToPicker(pickTab, { type: 'webrobot-picker-multi-config', containerSelector: sel || null }) } catch (_) {} }
// Row/link selectors must be GENERIC (class-pattern, no :nth-of-type) so they
// match EVERY row/link — use selector-list. Plain args stay selector-single.
function pickArg(i, name) {
  const row = pipeline.value[i]
  const m = isHighlightArg(row, name) ? 'selector-list' : 'selector-single'
  return beginPick({ stageIdx: i, kind: 'arg', argName: name }, m)
}
const pickArgList = (i, name) => beginPick({ stageIdx: i, kind: 'arg', argName: name }, 'multi-sample')
async function pickFields(i) {
  await beginPick({ stageIdx: i, kind: 'field-multi' }, 'multi-field')
  // flatSelect: scope fields to the segment + highlight ALL rows (badges).
  const row = pipeline.value[i]
  if (row.stage_name === 'flatSelect') await sendMultiConfig(row.args[segArgName(row)] || null)
}
// Clear current selections/highlights on the page (when the user mis-picks).
async function clearSelections() {
  try { await sendToPicker(pickTab, { type: 'webrobot-picker-multi-clear' }) } catch (_) {}
  try { await sendToPicker(pickTab, { type: 'webrobot-highlight-clear' }) } catch (_) {}
  await sendMultiConfig(null)
  try { await highlight([]) } catch (_) {}   // wipe background outlines
  testCounts.value = null
  await deactivatePicker()
  status.value = 'Selections cleared.'
}
const pickRowLca = (i, name) => beginPick({ stageIdx: i, kind: 'arg', argName: name }, 'selector-single')
const pickMarketBox = (i) => beginPick({ stageIdx: i, kind: 'market-box' }, 'selector-single')
const pickMacroBox = (i) => beginPick({ stageIdx: i, kind: 'macro-box' }, 'selector-single')
async function recordTrace(i) { recording.value = i; traceStage.value = i; pipeline.value[i]._trace = []; touch(); await beginPick({ stageIdx: i, kind: 'trace' }, 'action-record'); await recStart(pickTab) }
async function stopRecord(i) {
  await sendToPicker(pickTab, { type: 'webrobot-picker-stop-recording' }) // → emits webrobot-pick-actions
  await recStop()                  // stop multi-page re-injection
  recording.value = null
  await sleep(300)                 // let pick-actions round-trip back before we deactivate
  await deactivatePicker()         // pt reset is safe — trace routes via traceStage
  status.value = 'Recording stopped — trace ready (▶ Replay available).'
}

async function useCurrentUrl(i, name) {
  try { const u = await currentUrl(); if (u) { updateArg(i, name, u); status.value = 'URL: ' + u } }
  catch (e) { status.value = 'URL error: ' + e.message }
}

async function appendMarket(i, selector, html) {
  const m = (pipeline.value[i]._markets ||= []); const mi = m.length
  m.push({ label: '', sectionSelector: selector, rowSelector: '', fields: [], enabled: true, _html: html || '' })
  touch(); status.value = `Market ${mi + 1} — inferring…`; await inferMarket(i, mi)
}
async function inferMarket(i, mi) {
  const m = pipeline.value[i]._markets[mi]; if (!m) return
  oddsInferKey.value = `${i}:${mi}`
  try {
    const j = await inferOddsStructure({ label: m.label || '', section_html: m._html || '' })
    if (j.rowSelector) m.rowSelector = j.rowSelector
    if (Array.isArray(j.fields)) m.fields = j.fields.map(f => ({ selector: f.selector || '', as: f.as || 'field', method: f.method || 'text' }))
    if (!m.label) m.label = 'Market ' + (mi + 1)
    touch(); status.value = `Structure suggested for market ${mi + 1}.`
  } catch (e) { status.value = 'AI infer failed: ' + e.message } finally { oddsInferKey.value = null }
}

async function handlePick(p) {
  if (!p || !p.type) return
  if (p.type === 'webrobot-generalize-request') {
    try {
      const j = await inferSegment({ html: p.html || p.sampleHtmlFull || '', sample_html: p.sampleHtml || '' })
      await sendToPicker(pickTab, { type: 'webrobot-generalize-result', selector: j.selector || (j.candidates && j.candidates[0]) || '', requestId: p.requestId })
    } catch (_) { await sendToPicker(pickTab, { type: 'webrobot-generalize-result', selector: '', requestId: p.requestId }) }
    return
  }
  if (p.type === 'webrobot-picker-multi-warn') { status.value = p.warn || 'click outside segment'; return }
  // Trace recording result — routed via traceStage (survives pt reset), so it
  // lands even after Stop deactivated the picker. MUST be before the pt guard.
  if (p.type === 'webrobot-pick-actions') {
    const i = traceStage.value
    if (i != null && pipeline.value[i] && Array.isArray(p.actions)) {
      pipeline.value[i]._trace = p.actions.slice(); touch()
      status.value = `Recorded ${p.actions.length} action(s) → trace.`
    }
    return
  }
  const t = pt.value; if (!t) return
  const row = pipeline.value[t.stageIdx]; if (!row) return

  if (p.type === 'webrobot-pick-selector') {
    if (t.kind === 'market-box') { await appendMarket(t.stageIdx, p.selector, p.sampleHtmlFull || p.sampleHtml || ''); await deactivatePicker(); return }
    if (t.kind === 'macro-box') { row._aiBox = { selector: p.selector, html: p.sampleHtmlFull || p.sampleHtml || '' }; touch(); status.value = '📦 Content box set — describe fields then 🪄.'; await deactivatePicker(); return }
    if (t.kind === 'arg') {
      updateArg(t.stageIdx, t.argName, p.selector)
      status.value = `${t.argName} = ${p.selector}` + (p.matches != null ? ` (${p.matches})` : '')
      // flatSelect segment / explore-join link → highlight ALL matches (rows/
      // links) so the user sees the set; keep the picker active for that.
      if (isHighlightArg(row, t.argName)) await sendMultiConfig(p.selector)
      else await deactivatePicker()
    }
  } else if (p.type === 'webrobot-pick-multi-sample') {
    if (t.kind === 'arg') { updateArg(t.stageIdx, t.argName, p.selector); status.value = `${t.argName} = ${p.selector} (${p.matches || '?'} matches)`; if (isHighlightArg(row, t.argName)) await sendMultiConfig(p.selector); else await deactivatePicker() }
  } else if (p.type === 'webrobot-pick-multi-field') {
    if (t.kind !== 'field-multi') return
    const fields = (row._fields ||= []); const sel = (p.selector || '').trim()
    if (sel && fields.some(f => (f.selector || '').trim() === sel)) { status.value = 'duplicate skipped'; return }
    const guess = (() => { const s = (p.sampleText || '').trim(); if (!s || /^\d+([.,]\d+)?$/.test(s)) return 'field_' + (fields.length + 1); return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'field_' + (fields.length + 1) })()
    const attrs = Array.isArray(p.attributes) ? p.attributes : []
    const method = (!p.sampleText && attrs.includes('src')) ? 'attr(src)' : (!p.sampleText && attrs.includes('href')) ? 'attr(href)' : 'text'
    fields.push({ selector: sel, as: guess, method, _parallel: !!p.parallel, _sample: p.sampleText }); touch()
  }
}

// ── AI Magic ──
async function aiSuggestFields(i) {
  const row = pipeline.value[i]; aiBusy.value = true; status.value = '🪄 Inferring fields…'
  try {
    const box = row._aiBox
    const html = box ? box.html : await pageHtml()
    const j = await inferFields({ intent: row._aiIntent || 'extract the main fields', html, container_selector: row.stage_name === 'flatSelect' ? row.args[segArgName(row)] : (box ? box.selector : ''), stage_name: row.stage_name })
    const llm = (j.llm || j.fields || [])
    if (llm.length) {
      row._fields = llm.map(f => ({ selector: f.selector, as: f.as || 'field', method: (f.method || 'text').replace('attr:', 'attr(').replace(/^(attr\([^)]*)$/, '$1)'), _sample: f.sample }))
      touch(); status.value = `🪄 ${llm.length} field(s) suggested.`
    } else status.value = 'No fields suggested.'
  } catch (e) { status.value = 'AI fields failed: ' + e.message } finally { aiBusy.value = false }
}
async function aiInferRow(i) {
  const row = pipeline.value[i]; aiBusy.value = true; status.value = '🧙 Inferring row selector…'
  try {
    const html = await pageHtml()
    const j = await inferSegment({ intent: row._aiIntent || 'the repeating row/card', html })
    const sel = j.selector || (j.candidates && j.candidates[0])
    if (sel) { updateArg(i, segArgName(row), sel); status.value = '🧙 Row selector: ' + sel }
    else status.value = 'No row selector inferred.'
  } catch (e) { status.value = 'AI row failed: ' + e.message } finally { aiBusy.value = false }
}
async function aiArg(i, name) {
  const row = pipeline.value[i]; aiBusy.value = true; status.value = '🪄 Inferring selector…'
  try {
    const html = await pageHtml()
    const j = await inferSelector({ intent: row._aiIntent || name, html, arg_name: name, stage_name: row.stage_name })
    const sel = j.selector || (j.candidates && j.candidates[0])
    if (sel) { updateArg(i, name, sel); status.value = `🪄 ${name} = ${sel}` } else status.value = 'No selector inferred.'
  } catch (e) { status.value = 'AI selector failed: ' + e.message } finally { aiBusy.value = false }
}
async function aiRelax(i) {
  const row = pipeline.value[i]; const f = (row._fields || []).filter(x => (x.selector || '').trim()); if (!f.length) return
  aiBusy.value = true; status.value = '✨ Relaxing selectors…'
  try {
    const html = await pageHtml()
    const j = await relaxSelectors({ fields: f.map(x => ({ selector: x.selector, label: x.as })), html })
    if (Array.isArray(j.fields)) j.fields.forEach((rf, k) => { if (row._fields[k] && rf.selector) row._fields[k].selector = rf.selector })
    touch(); status.value = '✨ Selectors relaxed.'
  } catch (e) { status.value = 'Relax failed: ' + e.message } finally { aiBusy.value = false }
}
async function aiNames(i) {
  const f = pipeline.value[i]._fields || []; if (!f.length) return
  try {
    const j = await suggestFieldNames({ fields: f.map(x => ({ selector: x.selector, sample: x._sample || '' })) })
    if (Array.isArray(j.names)) j.names.forEach((n, k) => { if (f[k] && n) f[k].as = n }); touch(); status.value = 'Names suggested.'
  } catch (e) { status.value = 'names failed: ' + e.message }
}

// ── YAML ──
function yamlScalar(v) { const s = String(v ?? ''); if (s === '') return '""'; if (/[:#{}\[\],&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s); return s }
function traceToYaml(a) {
  if (!a || !a.type) return null
  if (a.type === 'Click' && a.selector) return `{ action: "click", selector: ${yamlScalar(a.selector)} }`
  if (a.type === 'Type' && a.selector) return `{ action: "input", selector: ${yamlScalar(a.selector)}, text: ${yamlScalar(a.text || '')} }`
  if (a.type === 'Hover' && a.selector) return `{ action: "hover", selector: ${yamlScalar(a.selector)} }`
  if (a.type === 'Wait') return `{ action: "wait", seconds: ${((a.ms != null ? Number(a.ms) : 1000) / 1000)} }`
  if (a.type === 'Scroll') return `{ action: "scroll", direction: "${Number(a.y || 0) < 0 ? 'up' : 'down'}", pixels: ${Math.abs(Number(a.y || 600))} }`
  return null
}
const fmtAction = (a) => !a || !a.type ? '' : a.type === 'Click' ? `Click("${a.selector}")` : a.type === 'Type' ? `Type("${a.selector}","${a.text || ''}")` : a.type === 'Hover' ? `Hover("${a.selector}")` : a.type === 'Scroll' ? `Scroll(${a.y || 0})` : `${a.type}()`
const wizYaml = computed(() => buildYaml())
function buildYaml() {
  const p = pipeline.value; if (!p.length) return '(add at least one stage)'
  const lines = ['pipeline:']
  for (const row of p) {
    const fields = (row._fields || []).filter(f => (f.selector || '').trim())
    const flatSplit = row.stage_name === 'flatSelect' && fields.some(f => f._parallel)
    lines.push(`  - stage: ${flatSplit ? 'parallelSelect' : row.stage_name}`)
    if (flatSplit) {
      const seg = row.args[segArgName(row)] || ''
      lines.push('    args:'); lines.push('      -')
      for (const f of fields) { const sel = f._parallel ? f.selector : (seg ? `${seg} ${f.selector}` : f.selector); lines.push(`        - { selector: ${yamlScalar(sel)}, method: ${yamlScalar(f.method || 'text')}, as: ${yamlScalar(f.as || '')} }`) }
      continue
    }
    if (row.stage_name === 'extract') {
      if (!fields.length) lines.push('    args: []')
      else { lines.push('    args:'); for (const f of fields) lines.push(`      - { selector: ${yamlScalar(f.selector)}, method: ${yamlScalar(f.method || 'text')}, as: ${yamlScalar(f.as || '')} }`) }
      continue
    }
    if (row.stage_name === 'flatSelect') {
      const seg = row.args[segArgName(row)] || ''
      lines.push('    args:'); lines.push(`      - ${yamlScalar(seg)}`)
      if (!fields.length) lines.push('      - []')
      else { lines.push('      -'); for (const f of fields) lines.push(`        - { selector: ${yamlScalar(f.selector)}, method: ${yamlScalar(f.method || 'text')}, as: ${yamlScalar(f.as || '')} }`) }
      continue
    }
    if (isOdds(row.stage_name)) {
      const mk = (row._markets || []).filter(m => m && m.enabled !== false && (m.sectionSelector || '').trim() && (m.fields || []).some(f => (f.selector || '').trim()))
      if (!mk.length) { lines.push('    args: []'); continue }
      lines.push('    args:'); lines.push('      - markets:')
      mk.forEach((m, mi) => {
        lines.push(`          - label: ${yamlScalar((m.label || '').trim() || 'Market ' + (mi + 1))}`)
        lines.push(`            sectionSelector: ${yamlScalar(m.sectionSelector)}`)
        if ((m.rowSelector || '').trim()) lines.push(`            rowSelector: ${yamlScalar(m.rowSelector)}`)
        lines.push('            fields:')
        for (const f of m.fields.filter(f => (f.selector || '').trim())) lines.push(`              - { selector: ${yamlScalar(f.selector)}, method: ${yamlScalar(f.method || 'text')}, as: ${yamlScalar(f.as || 'field')} }`)
      })
      continue
    }
    // generic + fetch-like trace
    const sch = argSchema(row.stage_name)
    const filled = sch.map(a => [a.name, row.args[a.name]]).filter(([, v]) => v != null && v !== '')
    const trace = FETCH_LIKE.has(row.stage_name) ? (row._trace || []).map(traceToYaml).filter(Boolean) : []
    if (!filled.length && !trace.length) { lines.push('    args: []'); continue }
    lines.push('    args:')
    for (const [n, v] of filled) lines.push(`      - ${yamlScalar(v)}    # ${n}`)
    if (trace.length) { lines.push('      -'); for (const e of trace) lines.push(`        - ${e}`) }
  }
  lines.push('output:'); lines.push('  format: parquet'); lines.push('  mode: overwrite')
  const meta = []
  if (wizRuntime.value && wizRuntime.value !== 'spark') meta.push(`  runtime: ${yamlScalar(wizRuntime.value)}`)
  if (wizGeo.value && /^[a-z]{2}$/i.test(wizGeo.value)) meta.push(`  geo: ${yamlScalar(wizGeo.value.toLowerCase())}`)
  if (meta.length) { lines.push('metadata:'); meta.forEach(m => lines.push(m)) }
  return lines.join('\n')
}

// ── validate / run ──
const validating = ref(false), running = ref(false)
const execId = ref(''), execState = ref(''), execLogs = ref(''), execRows = ref(null)
const validateRows = ref(null)   // { columns, rows } from server dry-run (Camoufox)
const testCounts = ref(null)     // local 👁 Test counts (real page, no Camoufox)
let pollTimer = null

// Normalize any array-of-objects (or {columns,rows}) into {columns, rows}.
function asTable(j) {
  if (!j) return null
  if (Array.isArray(j.rows) && Array.isArray(j.columns)) return { columns: j.columns, rows: j.rows }
  const arr = Array.isArray(j) ? j : (j.records || j.rows || j.preview || j.data)
  if (!Array.isArray(arr) || !arr.length) return { columns: [], rows: [] }
  const cols = []; arr.forEach(r => Object.keys(r || {}).forEach(k => { if (!cols.includes(k)) cols.push(k) }))
  return { columns: cols, rows: arr }
}

async function doValidate() {
  validating.value = true; validateRows.value = null; status.value = 'Validating on Camoufox…'
  try {
    const j = await validatePipeline({ yaml: wizYaml.value })
    if (j.ok === false) { status.value = 'Validation failed: ' + (j.error || ''); return }
    validateRows.value = asTable(j)
    status.value = `Validation OK — ${validateRows.value.rows.length} preview row(s).`
  } catch (e) { status.value = 'Validate error: ' + e.message } finally { validating.value = false }
}

// ── local on-page test (real tab, no Camoufox): highlight + count matches ──
async function testStage(i) {
  const row = pipeline.value[i]; testCounts.value = null
  const items = []
  if (row.stage_name === 'flatSelect') {
    const seg = row.args[segArgName(row)]
    if (seg) items.push({ selector: seg, color: '#4f46e5', label: 'segment' })
    for (const f of (row._fields || [])) if (f.selector) items.push({ selector: seg ? `${seg} ${f.selector}` : f.selector, color: '#10b981', label: f.as })
  } else if (row.stage_name === 'extract') {
    for (const f of (row._fields || [])) if (f.selector) items.push({ selector: f.selector, color: '#10b981', label: f.as })
  } else if (isOdds(row.stage_name)) {
    for (const m of (row._markets || [])) {
      if (m.sectionSelector) items.push({ selector: m.sectionSelector, color: '#f59e0b', label: m.label || 'market' })
      for (const f of (m.fields || [])) if (f.selector) items.push({ selector: (m.sectionSelector ? m.sectionSelector + ' ' : '') + (m.rowSelector ? m.rowSelector + ' ' : '') + f.selector, color: '#10b981', label: f.as })
    }
  } else {
    for (const a of argSchema(row.stage_name)) if (/selector/i.test(a.name) && row.args[a.name]) items.push({ selector: row.args[a.name], color: '#4f46e5', label: a.name })
  }
  if (!items.length) { status.value = 'Nothing to test on this stage.'; return }
  try { testCounts.value = await highlight(items); status.value = 'Tested on page — see highlights + counts below.' }
  catch (e) { status.value = 'Test error: ' + e.message }
}

async function replayTrace(i) {
  const t = pipeline.value[i]._trace || []; if (!t.length) return
  status.value = '▶ Replaying trace on the page…'
  await deactivatePicker(); await sleep(150)   // ensure the picker isn't eating the synthetic clicks
  try { const r = await runTrace(t); status.value = '▶ Replay done: ' + ((r.steps || []).join(', ') || 'no steps') }
  catch (e) { status.value = 'Replay error: ' + e.message }
}
async function run() {
  running.value = true; execRows.value = null; execLogs.value = ''; execState.value = 'submitting'; status.value = 'Submitting…'
  try {
    const j = await saveGeneratedPipeline({ pipeline_name: wizName.value, pipeline_yaml: wizYaml.value, execute: true })
    const ex = j.execution || {}
    const id = ex.execution_id || j.execution_id || ex.id || j.id
    if (!id) throw new Error('no execution id in response')
    execId.value = id; status.value = 'Running ' + id; poll()
  } catch (e) { running.value = false; execState.value = 'error'; status.value = 'Run error: ' + e.message }
}
async function poll() {
  try {
    const s = await executionStatus(execId.value); execState.value = s.status || s.state || JSON.stringify(s)
    const done = /SUCCEED|COMPLETE|FAIL|ERROR|KILLED/i.test(execState.value)
    try { const l = await executionLogs(execId.value); execLogs.value = (typeof l === 'string' ? l : (l.logs || JSON.stringify(l))).slice(-4000) } catch (_) {}
    if (done) { running.value = false; if (/SUCCEED|COMPLETE/i.test(execState.value)) { try { execRows.value = asTable(await executionOutput(execId.value)) } catch (_) {} } return }
    pollTimer = setTimeout(poll, 3000)
  } catch (e) { running.value = false; execState.value = 'error'; status.value = 'Poll error: ' + e.message }
}

onMounted(async () => { token.value = await getToken(); stopPick = onPick((p) => handlePick(p)); loadCatalog() })
onUnmounted(() => { stopPick && stopPick(); pollTimer && clearTimeout(pollTimer) })
</script>

<template>
  <div class="wrap">
    <header><strong>WebRobot Designer</strong><span class="muted">extension</span></header>
    <div class="row modebar">
      <span class="seg">
        <button :class="{active: mode==='demo'}" @click="mode='demo'">Demo</button>
        <button :class="{active: mode==='prod'}" @click="mode='prod'" title="Subscription / BYOC plans — coming soon">Production 🔒</button>
      </span>
      <button @click="loadCatalog" :disabled="loadingCatalog">↻ Stages</button>
      <button @click="clearSelections" title="Clear page highlights / picker selection (if you mis-picked)">✕ Clear</button>
    </div>
    <p v-if="mode==='demo'" class="muted small">Demo sandbox — public endpoint, no key needed (auto-auth).</p>
    <div v-else class="cs">
      🔒 <strong>Subscription &amp; BYOC plans — coming soon.</strong>
      <span>Run pipelines on your own account / cloud.</span>
      <button @click="openPlans" disabled>View plans →</button>
    </div>
    <p class="status" v-if="status">{{ status }}</p>

    <div class="cols">
      <section class="palette">
        <input v-model="search" placeholder="filter stages…" />
        <div class="plist">
          <button v-for="s in filtered" :key="s.stage_name" class="pitem" :title="s.description" @click="addStage(s)">{{ s.stage_name }}</button>
        </div>
      </section>

      <section class="editor">
        <input v-model="wizName" class="name" placeholder="pipeline name" />
        <p v-if="!pipeline.length" class="muted">Click stages to build the pipeline.</p>

        <div v-for="(row, i) in pipeline" :key="i" class="stage">
          <div class="shead">
            <strong>{{ i + 1 }}. {{ row.stage_name }}</strong>
            <span v-if="(row._trace||[]).length" class="badge" :title="(row._trace.length)+' actions'">🎬 {{ row._trace.length }}</span>
            <span class="sp"></span>
            <button @click="testStage(i)" title="highlight selectors on the real page + count matches">👁</button>
            <button @click="moveStage(i,-1)" :disabled="i===0">↑</button>
            <button @click="moveStage(i,1)" :disabled="i===pipeline.length-1">↓</button>
            <button @click="removeStage(i)">✕</button>
          </div>

          <!-- AI intent (shared by the magic buttons) -->
          <div class="airow" v-if="isStructured(row.stage_name) || !isOdds(row.stage_name)">
            <input :value="row._aiIntent" @input="setIntent(i,$event.target.value)" placeholder="describe what to extract / find (for 🪄 AI)" />
            <button @click="pickMacroBox(i)" :class="{on:row._aiBox}" :title="row._aiBox ? row._aiBox.selector : 'scope AI to a content box'">📦</button>
          </div>

          <template v-if="isStructured(row.stage_name)">
            <div v-if="row.stage_name==='flatSelect'" class="argrow">
              <label>{{ segArgName(row) }}</label>
              <input :value="row.args[segArgName(row)]||''" @input="updateArg(i,segArgName(row),$event.target.value)" placeholder="row/segment selector" />
              <button @click="pickArg(i,segArgName(row))" title="pick">🎯</button>
              <button @click="pickRowLca(i,segArgName(row))" title="2-click row wrapper">🧩</button>
              <button @click="aiInferRow(i)" :disabled="aiBusy" title="AI infer row selector">🧙</button>
            </div>
            <div class="fhead">
              <strong>Fields ({{ (row._fields||[]).length }})</strong>
              <button @click="pickFields(i)">🎯 Pick</button>
              <button @click="aiSuggestFields(i)" :disabled="aiBusy">🪄 AI fields</button>
              <button @click="aiRelax(i)" :disabled="aiBusy || !(row._fields||[]).length" title="LLM-relax selectors">✨</button>
              <button @click="aiNames(i)" :disabled="!(row._fields||[]).length">🏷 names</button>
              <button @click="addField(i)">+</button>
            </div>
            <table v-if="(row._fields||[]).length" class="ftab">
              <tr v-for="(f, fi) in row._fields" :key="fi">
                <td><input :value="f.as" @input="updField(i,fi,'as',$event.target.value)" placeholder="col"/></td>
                <td><input :value="f.method" @input="updField(i,fi,'method',$event.target.value)" placeholder="text"/></td>
                <td><input :value="f.selector" @input="updField(i,fi,'selector',$event.target.value)" placeholder="selector"/></td>
                <td><span v-if="f._parallel" title="outside segment → parallelSelect">∥</span></td>
                <td><button @click="rmField(i,fi)">✕</button></td>
              </tr>
            </table>
          </template>

          <template v-else-if="isOdds(row.stage_name)">
            <div class="fhead">
              <strong>Markets ({{ (row._markets||[]).filter(m=>m.enabled!==false).length }}/{{ (row._markets||[]).length }})</strong>
              <button @click="pickMarketBox(i)">📦 Add market</button>
            </div>
            <div v-for="(m, mi) in (row._markets||[])" :key="mi" class="market" :class="{off:m.enabled===false}">
              <div class="mhead">
                <input type="checkbox" :checked="m.enabled!==false" @change="updMarket(i,mi,'enabled',$event.target.checked)"/>
                <input :value="m.label" @input="updMarket(i,mi,'label',$event.target.value)" placeholder="label"/>
                <button @click="inferMarket(i,mi)" :disabled="oddsInferKey===(i+':'+mi)">🪄</button>
                <button @click="rmMarket(i,mi)">✕</button>
              </div>
              <input :value="m.sectionSelector" @input="updMarket(i,mi,'sectionSelector',$event.target.value)" placeholder="section selector"/>
              <input :value="m.rowSelector" @input="updMarket(i,mi,'rowSelector',$event.target.value)" placeholder="row selector"/>
              <table v-if="(m.fields||[]).length" class="ftab">
                <tr v-for="(f, fi) in m.fields" :key="fi">
                  <td><input :value="f.as" @input="updMarketField(i,mi,fi,'as',$event.target.value)" placeholder="role"/></td>
                  <td><input :value="f.method" @input="updMarketField(i,mi,fi,'method',$event.target.value)" placeholder="text"/></td>
                  <td><input :value="f.selector" @input="updMarketField(i,mi,fi,'selector',$event.target.value)" placeholder="selector"/></td>
                </tr>
              </table>
              <button @click="addMarketField(i,mi)">+ field</button>
            </div>
          </template>

          <template v-else>
            <div v-for="a in argSchema(row.stage_name)" :key="a.name" class="argrow">
              <label :title="a.description">{{ a.name }}<span v-if="a.required">*</span></label>
              <input :value="row.args[a.name]||''" @input="updateArg(i,a.name,$event.target.value)" :placeholder="a.type||'value'"/>
              <button v-if="/url|uri/i.test(a.name)" @click="useCurrentUrl(i,a.name)" title="use current tab URL">⎘</button>
              <button v-if="/selector/i.test(a.name)" @click="pickArg(i,a.name)" title="pick">🎯</button>
              <button v-if="/selector/i.test(a.name)" @click="pickArgList(i,a.name)" title="pick 2+ examples (list)">⋯</button>
              <button v-if="/selector/i.test(a.name)" @click="aiArg(i,a.name)" :disabled="aiBusy" title="AI infer">🪄</button>
            </div>
            <!-- trace recorder for fetch-like stages -->
            <div v-if="FETCH_LIKE.has(row.stage_name)" class="fhead">
              <strong>Trace ({{ (row._trace||[]).length }})</strong>
              <button v-if="recording!==i" @click="recordTrace(i)">⏺ Record</button>
              <button v-else @click="stopRecord(i)" class="rec">⏹ Stop</button>
              <button v-if="(row._trace||[]).length" @click="replayTrace(i)" title="execute the trace on the page">▶ Replay</button>
              <button v-if="(row._trace||[]).length" @click="clearTrace(i)">clear</button>
            </div>
            <ul v-if="(row._trace||[]).length" class="trace">
              <li v-for="(a, ai) in row._trace" :key="ai"><code>{{ fmtAction(a) }}</code><button @click="rmTrace(i,ai)">✕</button></li>
            </ul>
            <p v-if="!argSchema(row.stage_name).length && !FETCH_LIKE.has(row.stage_name)" class="muted">no args</p>
          </template>
        </div>

        <div v-if="pipeline.length" class="settings">
          <label>🌍 Geo <select v-model="wizGeo"><option v-for="z in GEO_ZONES" :key="z.code" :value="z.code">{{ z.label }}</option></select></label>
          <label>🖥 Runtime <select v-model="wizRuntime"><option value="spark">Spark</option><option value="ray_actor">Ray actor</option></select></label>
          <p v-if="wizRuntime==='ray_actor'" class="warn">🚧 Ray actor under design (Phase-4) — records metadata.runtime, runs on Spark for now.</p>
        </div>

        <div v-if="pipeline.length">
          <h4>YAML</h4>
          <pre class="yaml">{{ wizYaml }}</pre>
          <div class="row">
            <button @click="doValidate" :disabled="validating">✓ Validate (Camoufox)</button>
            <button class="run" @click="run" :disabled="running">▶ Run</button>
          </div>
        </div>

        <!-- local on-page test results (real tab) -->
        <div v-if="testCounts" class="testc">
          <strong>👁 On-page matches</strong>
          <span v-for="(c,ci) in testCounts" :key="ci" class="chip" :class="{zero:c.count===0}">{{ c.label||c.selector }}: {{ c.count }}</span>
        </div>

        <!-- server dry-run preview rows (Camoufox) -->
        <div v-if="validateRows" class="out">
          <strong>Validate preview — {{ validateRows.rows.length }} row(s)</strong>
          <div v-if="!validateRows.rows.length" class="muted">no rows (selectors matched nothing through Camoufox)</div>
          <table v-else class="ftab">
            <tr><th v-for="c in validateRows.columns" :key="c">{{ c }}</th></tr>
            <tr v-for="(r,ri) in validateRows.rows.slice(0,10)" :key="ri"><td v-for="c in validateRows.columns" :key="c">{{ r[c] }}</td></tr>
          </table>
        </div>

        <div v-if="execId" class="exec">
          <div><strong>{{ execId }}</strong> — <span :class="{ok:/SUCCEED|COMPLETE/i.test(execState), bad:/FAIL|ERROR|KILLED/i.test(execState)}">{{ execState }}</span></div>
          <pre v-if="execLogs" class="logs">{{ execLogs }}</pre>
          <div v-if="execRows && execRows.rows && execRows.rows.length" class="out">
            <table class="ftab"><tr><th v-for="c in execRows.columns" :key="c">{{ c }}</th></tr>
              <tr v-for="(r, ri) in execRows.rows.slice(0,10)" :key="ri"><td v-for="c in execRows.columns" :key="c">{{ r[c] }}</td></tr></table>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font: 13px/1.45 system-ui, sans-serif; color: #1f2430; }
.wrap { padding: 10px; }
header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.muted { color: #888; }
.row { display: flex; gap: 6px; margin: 6px 0; flex-wrap: wrap; }
.row input[type=password] { flex: 1; }
input, select { padding: 4px 6px; border: 1px solid #d4d7e2; border-radius: 6px; font: inherit; }
button { padding: 4px 7px; border: 1px solid #c7cbe0; background: #f3f4fb; border-radius: 6px; cursor: pointer; }
button:hover { background: #e9ebf7; } button.on { background: #ddd6fe; }
button.run { background: linear-gradient(135deg,#4f46e5,#764ba2); color:#fff; border:0; }
button.rec { background: #fecaca; }
.status { color: #4f46e5; font-size: 12px; margin: 4px 0; word-break: break-word; }
.small { font-size: 11px; margin: 2px 0 6px; }
.modebar { align-items: center; }
.seg { display: inline-flex; border: 1px solid #c7cbe0; border-radius: 999px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; background: #fff; padding: 4px 12px; }
.seg button.active { background: linear-gradient(135deg,#4f46e5,#764ba2); color: #fff; }
.cs { background: #fef3c7; border: 1px solid #fde68a; color: #92400e; border-radius: 8px; padding: 8px; margin: 4px 0 8px; font-size: 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.cs button[disabled] { opacity: .6; }
.cols { display: flex; gap: 10px; align-items: flex-start; }
.palette { width: 140px; flex: none; }
.palette input { width: 100%; margin-bottom: 6px; }
.plist { display: flex; flex-direction: column; gap: 3px; max-height: 74vh; overflow: auto; }
.pitem { text-align: left; font-size: 12px; }
.editor { flex: 1; min-width: 0; }
.name { width: 100%; margin-bottom: 6px; font-weight: 600; }
.stage { border: 1px solid #e6e8ef; border-radius: 8px; padding: 8px; margin-bottom: 8px; }
.shead { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; }
.sp { flex: 1; } .badge { font-size: 11px; color: #b45309; }
.airow { display: flex; gap: 4px; margin: 4px 0; }
.airow input { flex: 1; }
.argrow { display: flex; align-items: center; gap: 4px; margin: 3px 0; }
.argrow label { font-size: 11px; min-width: 64px; color: #555; }
.argrow input { flex: 1; }
.fhead { display: flex; align-items: center; gap: 5px; margin: 6px 0 4px; flex-wrap: wrap; }
.ftab { width: 100%; border-collapse: collapse; }
.ftab td, .ftab th { padding: 1px; text-align: left; }
.ftab input { width: 100%; }
.trace { list-style: none; padding: 0; margin: 2px 0; }
.trace li { display: flex; justify-content: space-between; align-items: center; font-size: 11px; padding: 1px 0; }
.market { border: 1px solid #eee; border-left: 3px solid #f59e0b; border-radius: 6px; padding: 6px; margin: 4px 0; }
.market.off { opacity: .5; } .market > input { width: 100%; margin: 2px 0; }
.mhead { display: flex; gap: 4px; align-items: center; } .mhead input:not([type=checkbox]) { flex: 1; }
.settings { background: #f7f8fc; border: 1px solid #e6e8ef; border-radius: 8px; padding: 8px; margin: 8px 0; }
.settings label { margin-right: 12px; }
.warn { color: #92400e; background: #fef3c7; border-radius: 6px; padding: 6px; margin: 6px 0 0; font-size: 12px; }
.yaml { background: #0d0f1c; color: #d4d4d4; padding: 10px; border-radius: 8px; overflow-x: auto; font: 11px/1.5 ui-monospace, monospace; white-space: pre; }
.out { margin-top: 8px; } .out table { font-size: 11px; }
.testc { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.testc .chip { font-size: 11px; background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 999px; padding: 1px 8px; }
.testc .chip.zero { background: #fee2e2; border-color: #fecaca; color: #b91c1c; }
.exec { margin-top: 8px; border-top: 1px solid #e6e8ef; padding-top: 8px; }
.exec .ok { color: #16a34a; font-weight: 700; } .exec .bad { color: #dc2626; font-weight: 700; }
.logs { background: #111; color: #9fe; padding: 8px; border-radius: 6px; max-height: 180px; overflow: auto; font: 11px/1.4 ui-monospace, monospace; }
h4 { margin: 8px 0 4px; }
</style>
