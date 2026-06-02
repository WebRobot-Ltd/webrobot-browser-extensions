<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import yaml from 'js-yaml'
import {
  catalogStages, listPipelines, getToken, setToken, startPicker, onPick, sendToPicker,
  inferSegment, inferSelector, inferFields, inferOddsStructure, suggestFieldNames,
  relaxSelectors, validatePipeline, saveGeneratedPipeline, executeByName, uploadCsv,
  executionStatus, executionLogs, executionOutput, currentUrl, pageHtml,
  runTrace, highlight, recStart, recStop,
} from './api.js'
import logoUrl from './logo-webrobot.png'

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

// ── catalog grouped by category (parity with DemoApp.vue palette) ──
const CATEGORY_ORDER = [
  'source', 'io', 'connector', 'external-api',
  'crawling', 'browsing', 'intelligent',
  'extraction', 'matching',
  'transformation', 'python', 'utility',
  'analytics', 'rag', 'ml',
  'sink', 'output',
  'use-case',
]
const CATEGORY_LABELS = {
  'source': '📥 Sources', 'io': '📂 I/O', 'connector': '🔌 Connectors',
  'external-api': '🌐 External APIs', 'crawling': '🕷 Crawling', 'browsing': '🌍 Browsing',
  'intelligent': '🪄 Intelligent (LLM)', 'extraction': '🎯 Extraction', 'matching': '🔗 Matching',
  'transformation': '🔧 Transformation', 'python': '🐍 Python', 'utility': '🔩 Utility',
  'analytics': '📊 Analytics', 'rag': '🧠 RAG', 'ml': '🤖 ML',
  'sink': '💾 Sinks', 'output': '📤 Output', 'use-case': '📦 Use cases',
  'Uncategorized': '· Other',
}
// Use the catalog `category` when present; otherwise infer from stage_name/plugin_id.
function inferStageCategory(s) {
  if (!s) return 'Uncategorized'
  if (s.category && String(s.category).trim()) return String(s.category).trim()
  const name = (s.stage_name || '').toLowerCase()
  const plug = (s.plugin_id || '').toLowerCase()
  if (plug.includes('rag')) return 'rag'
  if (plug.includes('sentiment') || plug.includes('price-comparison') || plug.includes('real-estate') || plug.includes('lead')) return 'use-case'
  if (plug.includes('python')) return 'python'
  if (/^load_|^read_|^fetch_csv$|^from_/.test(name)) return 'io'
  if (/^save_|^write_|^to_/.test(name)) return 'io'
  if (name.includes('fetch') || name.includes('visit') || name.includes('wget') || name.includes('explore') || name.includes('crawl')) return 'crawling'
  if (name.includes('intelligent') || name.includes('aimagic') || name.endsWith('_ai')) return 'intelligent'
  if (name.includes('extract') || name === 'flatselect' || name === 'iextract') return 'extraction'
  if (name.includes('join') || name.includes('match')) return 'matching'
  if (name.includes('sentiment') || name.includes('aggregate')) return 'analytics'
  if (name.includes('rag') || name.includes('embed') || name.includes('vector')) return 'rag'
  if (name.includes('python') || name.includes('udf')) return 'python'
  if (name.includes('api') || name.endsWith('api') || name.startsWith('macro')) return 'external-api'
  if (name.includes('filter') || name.includes('sort') || name.includes('limit') || name.includes('dedupe')) return 'utility'
  if (name.includes('connector') || /^mysql|^postgres|^mongo|^kafka|^elastic|^cassandra/.test(name)) return 'connector'
  return 'Uncategorized'
}
const catalogGroups = computed(() => {
  const map = new Map()
  for (const s of filtered.value) {
    const cat = inferStageCategory(s)
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat).push(s)
  }
  for (const items of map.values()) items.sort((a, b) => a.stage_name.localeCompare(b.stage_name))
  const groups = []
  for (const known of CATEGORY_ORDER) {
    if (map.has(known)) { groups.push({ category: known, items: map.get(known) }); map.delete(known) }
  }
  const rest = Array.from(map.entries()).filter(([c]) => c !== 'Uncategorized').sort((a, b) => a[0].localeCompare(b[0]))
  for (const [cat, items] of rest) groups.push({ category: cat, items })
  if (map.has('Uncategorized')) groups.push({ category: 'Uncategorized', items: map.get('Uncategorized') })
  return groups.map(g => ({ ...g, label: CATEGORY_LABELS[g.category] || ('· ' + g.category) }))
})

// ── pipeline ──
const pipeline = ref([])
const wizName = ref('extension-pipeline')
const wizCategory = ref('')        // organizational category → metadata.category
const wizDatasetId = ref('')       // optional input dataset id (load_csv pipelines)
function addStage(s) { pipeline.value.push({ stage_name: s.stage_name, args: {}, _fields: [], _markets: [], _trace: [], _aiIntent: '', _aiBox: null }) }
function removeStage(i) { pipeline.value.splice(i, 1) }
function moveStage(i, d) { const j = i + d; if (j < 0 || j >= pipeline.value.length) return; const a = pipeline.value;[a[i], a[j]] = [a[j], a[i]]; pipeline.value = [...a] }
const touch = () => { pipeline.value = [...pipeline.value] }
// ── existing pipelines (open + edit) ──
const existingList = ref([])
const existingSel = ref('')
async function loadExisting() {
  try { const j = await listPipelines(); existingList.value = (j && j.demos) || [] }
  catch (e) { status.value = 'List error: ' + e.message }
}
function openExisting(name) {
  const d = existingList.value.find(x => x.pipeline_name === name)
  if (!d) return
  const rows = parseYamlToPipeline(d.pipeline_yaml || '')
  if (!rows) return
  pipeline.value = rows
  wizName.value = d.pipeline_name || 'pipeline'
  if (d.category_name) wizCategory.value = d.category_name
  status.value = `Loaded "${d.pipeline_name}" (${rows.length} stage${rows.length === 1 ? '' : 's'}) — editable.`
}
function actionMapToTrace(m) {
  if (!m || !m.action) return null
  const act = String(m.action).toLowerCase()
  if (act === 'click')  return { type: 'Click', selector: m.selector }
  if (act === 'input')  return { type: 'Type', selector: m.selector, text: m.text || '' }
  if (act === 'hover')  return { type: 'Hover', selector: m.selector }
  if (act === 'wait')   return { type: 'Wait', ms: Math.round((m.seconds != null ? m.seconds : 1) * 1000) }
  if (act === 'scroll') return { type: 'Scroll', y: (m.direction === 'up' ? -1 : 1) * (m.pixels || 600) }
  return null
}
// Inverse of buildYaml: parse a pipeline YAML back into the editor model.
function parseYamlToPipeline(text) {
  let doc
  try { doc = yaml.load(text) } catch (e) { status.value = 'YAML parse error: ' + e.message; return null }
  if (!doc || !Array.isArray(doc.pipeline)) { status.value = 'No pipeline[] found in YAML.'; return null }
  const rows = []
  for (const st of doc.pipeline) {
    if (!st || !st.stage) continue
    let name = st.stage
    const a = st.args
    const row = { stage_name: name, args: {}, _fields: [], _markets: [], _trace: [], _aiIntent: '', _aiBox: null }
    const fld = (x) => ({ selector: x.selector || '', as: x.as || 'field', method: x.method || 'text' })
    if (name === 'extract') {
      row._fields = (Array.isArray(a) ? a : []).filter(f => f && f.selector).map(fld)
    } else if (name === 'flatSelect') {
      row.args[segArgName(row)] = Array.isArray(a) ? (a[0] || '') : ''
      row._fields = (Array.isArray(a) && Array.isArray(a[1]) ? a[1] : []).filter(f => f && f.selector).map(fld)
    } else if (name === 'parallelSelect' || name === 'parallel_select') {
      // round-trips as flatSelect with parallel (page-rooted) fields
      row.stage_name = 'flatSelect'
      const list = Array.isArray(a) && Array.isArray(a[0]) ? a[0] : []
      row._fields = list.filter(f => f && f.selector).map(f => ({ ...fld(f), _parallel: true }))
    } else if (isOdds(name)) {
      const cfg = Array.isArray(a) ? a.find(x => x && x.markets) : (a && a.markets ? a : null)
      row._markets = ((cfg && cfg.markets) || []).map((m, mi) => ({
        label: m.label || ('Market ' + (mi + 1)), sectionSelector: m.sectionSelector || '',
        rowSelector: m.rowSelector || '', enabled: true, _html: '',
        fields: (m.fields || []).filter(f => f && f.selector).map(fld),
      }))
    } else if (FETCH_LIKE.has(name)) {
      if (Array.isArray(a)) {
        if (typeof a[0] === 'string') row.args[urlArgName(row)] = a[0]
        const tr = a.find(x => Array.isArray(x))
        if (Array.isArray(tr)) row._trace = tr.map(actionMapToTrace).filter(Boolean)
      } else if (typeof a === 'string') { row.args[urlArgName(row)] = a }
    } else {
      const sch = argSchema(name)
      if (Array.isArray(a)) a.forEach((v, i) => { if (sch[i] && (typeof v === 'string' || typeof v === 'number')) row.args[sch[i].name] = v })
      else if (a && typeof a === 'object') for (const k of Object.keys(a)) row.args[k] = a[k]
    }
    rows.push(row)
  }
  const meta = doc.metadata || {}
  if (meta.geo) wizGeo.value = String(meta.geo)
  if (meta.runtime) wizRuntime.value = String(meta.runtime)
  if (meta.category) wizCategory.value = String(meta.category)
  return rows
}
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
const LINK_STAGES = new Set([
  'explore', 'join', 'visitExplore', 'visitJoin', 'wgetExplore', 'wgetJoin',
  'wget_explore', 'wget_join', 'intelligent_explore', 'intelligent_join', 'intelligentJoin',
])
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
  const row = pipeline.value[i]; const f = row._fields || []
  // Endpoint contract: body { items:[{selector,sample}], stage_name },
  // response { fields:[{as}, …] } zipped by index to the kept items.
  const items = f.map((x, k) => ({ _idx: k, selector: (x.selector || '').trim(), sample: (x._sample || '').slice(0, 200) }))
                 .filter(it => it.selector)
  if (!items.length) { status.value = 'Pick a field selector before naming.'; return }
  try {
    const j = await suggestFieldNames({ items: items.map(it => ({ selector: it.selector, sample: it.sample })), stage_name: row.stage_name })
    const sug = Array.isArray(j.fields) ? j.fields : []
    if (!sug.length) { status.value = 'LLM returned no names.'; return }
    sug.forEach((sg, k) => { const idx = items[k] && items[k]._idx; if (idx != null && f[idx] && sg.as) f[idx].as = sg.as })
    touch(); status.value = `🏷 Suggested ${sug.length} name(s).`
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
// Client-side pre-validation: block Run when required inputs are missing
// (e.g. a fetch with no URL, a flatSelect with no row selector/fields).
const pipelineIssues = computed(() => {
  const out = []
  if (!pipeline.value.length) return out
  pipeline.value.forEach((row, i) => {
    const n = i + 1, name = row.stage_name
    const has = (k) => (row.args[k] != null && String(row.args[k]).trim() !== '')
    if (name === 'extract') {
      if (!(row._fields || []).some(f => (f.selector || '').trim())) out.push(`${n}. extract — add at least one field`)
    } else if (name === 'flatSelect') {
      if (!has(segArgName(row))) out.push(`${n}. flatSelect — set the row/segment selector`)
      if (!(row._fields || []).some(f => (f.selector || '').trim())) out.push(`${n}. flatSelect — add at least one field`)
    } else if (isOdds(name)) {
      const ok = (row._markets || []).some(m => m && m.enabled !== false && (m.sectionSelector || '').trim() && (m.fields || []).some(f => (f.selector || '').trim()))
      if (!ok) out.push(`${n}. oddsSelect — add an enabled market with a section + fields`)
    } else {
      for (const a of argSchema(name)) {
        if (a.required && !has(a.name)) out.push(`${n}. ${name} — missing "${a.name}"`)
      }
    }
  })
  return out
})
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
  if (wizCategory.value && wizCategory.value.trim()) meta.push(`  category: ${yamlScalar(wizCategory.value.trim())}`)
  if (meta.length) { lines.push('metadata:'); meta.forEach(m => lines.push(m)) }
  return lines.join('\n')
}

// ── validate / run ──
const validating = ref(false), running = ref(false)
const execId = ref(''), execState = ref(''), execLogs = ref(''), execRows = ref(null), outDatasetId = ref(null)
const execInfo = ref(null)        // full status object (phase, message, driver/executors, …)
const validateRows = ref(null)   // { columns, rows } from server dry-run (Camoufox)
const testCounts = ref(null)     // local 👁 Test counts (real page, no Camoufox)
let pollTimer = null

// Normalize any array-of-objects (or {columns,rows}) into {columns, rows}.
function asTable(j) {
  if (!j) return null
  if (Array.isArray(j.rows) && Array.isArray(j.columns)) {
    // Trino/parquet output returns rows as POSITIONAL arrays (["v0","v1",…]);
    // the template + CSV index by column NAME (r[c]). Map positional rows to
    // objects keyed by column so both render correctly. Rows already keyed
    // (array-of-objects) pass through unchanged.
    const rows = j.rows.map(r => Array.isArray(r)
      ? Object.fromEntries(j.columns.map((c, i) => [c, r[i]]))
      : r)
    return { columns: j.columns, rows }
  }
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
// Templatize (future): detect candidate variables in the pipeline (values that
// could be parameterized) and bind them to dataset columns → reusable template
// to publish on the marketplace. Button + coming-soon notice for now.
const showTpl = ref(false)
const showExec = ref(false)        // job status/logs modal (roomier than inline)
// ── Run modal (mirrors the demo app's "run pipeline" dialog) ──
const showRunModal = ref(false)
const runMode = ref('none')        // 'none' (auto-trigger) | 'existing' | 'upload'
const runCsvText = ref('')
function openRunModal() {
  if (!pipeline.value.length) { status.value = 'Add at least one stage first.'; return }
  if (pipelineIssues.value.length) { status.value = '⚠ Fix ' + pipelineIssues.value.length + ' issue(s) before running.'; return }
  clearSelections()   // clear page highlights + release the picker before running
  showRunModal.value = true
}
async function runConfirm() {
  const name = (wizName.value || '').trim()
  if (!name) { status.value = 'Give the pipeline a name first.'; return }
  showRunModal.value = false
  running.value = true; execRows.value = null; execLogs.value = ''; execState.value = 'saving'; status.value = 'Saving…'
  try {
    // Resolve the input dataset per mode (only when an input is actually needed).
    let datasetId = null
    if (runMode.value === 'existing') {
      datasetId = (wizDatasetId.value || '').trim() || null
    } else if (runMode.value === 'upload') {
      if (!runCsvText.value.trim()) { running.value = false; status.value = 'Paste CSV (or pick No dataset).'; return }
      await saveGeneratedPipeline({ pipeline_name: name, pipeline_yaml: wizYaml.value, execute: false }) // draft so upload can attach
      status.value = 'Uploading dataset…'
      datasetId = (await uploadCsv(name, runCsvText.value, 'input.csv')).datasetId
    }
    // Save + execute in ONE call (wizard parity): the response carries
    // execution.{execution_id, output_dataset_id} — the latter is what makes
    // the output preview work (executeByName did NOT return it).
    status.value = 'Submitting…'; execState.value = 'submitting'
    const body = { pipeline_name: name, pipeline_yaml: wizYaml.value, execute: true }
    if (datasetId) body.datasetId = datasetId
    let j = await saveGeneratedPipeline(body)
    // 'none' on a pipeline that needs a trivial input → attach a 1-row trigger and retry.
    if (j.execution_error && /input dataset is required/i.test(j.execution_error) && runMode.value === 'none') {
      status.value = 'Attaching trigger dataset…'
      const dsId = (await uploadCsv(name, 'trigger\ngo\n', 'trigger.csv')).datasetId
      j = await saveGeneratedPipeline({ pipeline_name: name, pipeline_yaml: wizYaml.value, execute: true, datasetId: dsId })
    }
    if (j.execution_error) { running.value = false; execState.value = 'error'; status.value = 'Saved but execution failed: ' + j.execution_error; return }
    const ex = j.execution || {}
    const id = ex.execution_id || j.execution_id
    if (!id) { running.value = false; execState.value = 'error'; status.value = 'Saved but no execution_id — check Jersey logs.'; return }
    execId.value = id; outDatasetId.value = ex.output_dataset_id || j.output_dataset_id || null
    showExec.value = true            // open the roomy status/logs modal
    status.value = 'Running ' + id; poll()
  } catch (e) { running.value = false; execState.value = 'error'; status.value = 'Run error: ' + e.message }
}
function refreshStatus() { if (!execId.value) return; if (pollTimer) clearTimeout(pollTimer); poll() }
// Reset the execution panel/modal so the user can start a fresh run.
function clearStatus() {
  if (pollTimer) clearTimeout(pollTimer)
  running.value = false; showExec.value = false
  execId.value = ''; execState.value = ''; execLogs.value = ''; execRows.value = null; execInfo.value = null; outDatasetId.value = null
  status.value = 'Status cleared.'
}
async function poll() {
  try {
    const s = await executionStatus(execId.value)
    execInfo.value = (s && typeof s === 'object') ? s : null
    let st = (s && (s.status || s.phase)) || 'UNKNOWN'
    // The demo_execution DB status lags when the completion webhook doesn't
    // fire (known SPOF) → "stuck RUNNING". Trust the driver pod's terminal
    // phase from the kube enrichment instead.
    const drv = (s && s.driver) || {}
    const dph = String(drv.phase || '').toLowerCase()
    const drsn = String(drv.reason || '').toLowerCase()
    if (dph === 'failed' || /error|crashloopbackoff|backoff/.test(drsn)) st = 'FAILED'
    else if (dph === 'succeeded' && /running|unknown|submitting|pending/i.test(st)) st = 'SUCCEEDED'
    execState.value = st
    const done = /SUCCEED|COMPLETE|FAIL|ERROR|KILLED/i.test(st)
    try { const l = await executionLogs(execId.value); execLogs.value = (typeof l === 'string' ? l : (l.logs || JSON.stringify(l))).slice(-6000) } catch (_) {}
    if (done) {
      running.value = false
      if (/SUCCEED|COMPLETE/i.test(execState.value)) fetchOutput()  // parquet/indexing may lag → retry
      return
    }
    pollTimer = setTimeout(poll, 3000)
  } catch (e) { running.value = false; execState.value = 'error'; status.value = 'Poll error: ' + e.message }
}
// Output preview lags the SUCCEEDED status (Spark writes parquet, Trino indexes
// it). Retry a few times with the output dataset id until rows show up.
async function fetchOutput(tries = 8) {
  const dsId = outDatasetId.value || (execInfo.value && execInfo.value.output_dataset_id)
  try {
    const t = asTable(await executionOutput(execId.value, dsId, 10))
    if (t && t.rows && t.rows.length) { execRows.value = t; return }
    execRows.value = t  // keep the (empty) shape so columns can show
  } catch (_) {}
  if (tries > 1) { status.value = 'Job done — waiting for output rows…'; setTimeout(() => fetchOutput(tries - 1), 4000) }
  else status.value = 'Job done. Output preview empty (dataset may still be indexing).'
}
// Download the current preview rows as CSV.
function downloadCsv() {
  const t = execRows.value; if (!t || !t.rows || !t.rows.length) return
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  const lines = [t.columns.map(esc).join(',')]
  for (const r of t.rows) lines.push(t.columns.map(c => esc(r[c])).join(','))
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = (wizName.value || 'preview') + '.csv'; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

onMounted(async () => { token.value = await getToken(); stopPick = onPick((p) => handlePick(p)); loadCatalog(); loadExisting() })
onUnmounted(() => { stopPick && stopPick(); pollTimer && clearTimeout(pollTimer) })
</script>

<template>
  <div class="wrap">
    <header><img :src="logoUrl" alt="WebRobot" class="logo"><span class="muted">Designer</span></header>
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
          <template v-for="g in catalogGroups" :key="g.category">
            <div class="pcat">{{ g.label }} <span class="pcat-n">{{ g.items.length }}</span></div>
            <button v-for="s in g.items" :key="s.stage_name" class="pitem" :title="s.description" @click="addStage(s)">{{ s.stage_name }}</button>
          </template>
        </div>
      </section>

      <section class="editor">
        <div class="row">
          <select v-model="existingSel" class="text-input" style="flex:1" @focus="existingList.length || loadExisting()" @change="existingSel && openExisting(existingSel)">
            <option value="">📂 Open existing pipeline…</option>
            <option v-for="d in existingList" :key="d.pipeline_name" :value="d.pipeline_name">{{ d.is_draft ? '✏️ ' : '' }}{{ d.pipeline_name }}</option>
          </select>
          <button @click="loadExisting" title="Refresh pipeline list">↻</button>
        </div>
        <div class="pmeta">
          <input v-model="wizName" class="name" placeholder="pipeline name *" />
          <input v-model="wizCategory" class="name" placeholder="category (optional)" />
        </div>
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
          <div v-if="pipelineIssues.length" class="issues">
            ⚠ <strong>Fix before running:</strong>
            <ul><li v-for="(m, k) in pipelineIssues" :key="k">{{ m }}</li></ul>
          </div>
          <div class="row">
            <button @click="doValidate" :disabled="validating">✓ Validate (Camoufox)</button>
            <button class="run" @click="openRunModal" :disabled="running || pipelineIssues.length>0" :title="pipelineIssues.length ? 'Fix the issues above first' : 'Run the pipeline'">▶ Run</button>
            <button @click="showTpl=true" title="Turn this pipeline into a reusable template and publish it on the marketplace">📦 Templatize</button>
          </div>
          <div v-if="showTpl" class="cs">
            🚧 <strong>Templatize &amp; publish — coming soon.</strong>
            <span>Detects candidate variables in the pipeline (e.g. a search keyword or URL part) and binds them to <strong>dataset columns</strong> ($col), turning the pipeline into a reusable template to publish on the WebRobot marketplace.</span>
            <button @click="showTpl=false">Got it</button>
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

        <div v-if="execId" class="exec-chip">
          <span class="dotst" :class="{ok:/SUCCEED|COMPLETE/i.test(execState), bad:/FAIL|ERROR|KILLED/i.test(execState)}">●</span>
          <code>{{ execId }}</code> — {{ execState }}
          <button @click="showExec=true">📊 Job status</button>
          <button @click="clearStatus" title="Clear / dismiss this run">🧹 Clear</button>
        </div>
      </section>
    </div>

    <!-- Job status / logs / output — roomy modal (the side panel is narrow) -->
    <div v-if="showExec && execId" class="modal-bg" @click.self="showExec=false">
      <div class="modal modal-lg">
        <div class="modal-head">
          <strong>Job</strong> <code>{{ execId }}</code>
          <span class="state" :class="{ok:/SUCCEED|COMPLETE/i.test(execState), bad:/FAIL|ERROR|KILLED/i.test(execState)}">{{ execState }}</span>
          <span class="sp"></span>
          <button @click="refreshStatus">↻ Refresh</button>
          <button @click="clearStatus">🧹 Clear</button>
          <button @click="showExec=false">✕</button>
        </div>
        <div v-if="execInfo" class="kube">
          <div class="krow"><span class="kk">Phase</span><span>{{ execInfo.phase || execInfo.status || '—' }}</span></div>
          <div class="krow" v-if="execInfo.progress_message || execInfo.message"><span class="kk">Message</span><span>{{ execInfo.progress_message || execInfo.message }}</span></div>
          <div class="krow" v-if="execInfo.error_message"><span class="kk">Error</span><span class="bad">{{ execInfo.error_message }}</span></div>
          <div class="krow" v-if="execInfo.driver"><span class="kk">Driver pod</span><span>{{ execInfo.driver.phase }}<template v-if="execInfo.driver.ready"> ✓</template><template v-if="execInfo.driver.image_pulling"> · pulling image</template><template v-if="execInfo.driver.reason"> ({{ execInfo.driver.reason }})</template><template v-if="execInfo.driver.node"> @{{ execInfo.driver.node }}</template></span></div>
          <div class="krow" v-if="execInfo.executors_total != null"><span class="kk">Executors</span><span>{{ execInfo.executors_ready || 0 }}/{{ execInfo.executors_total }} ready</span></div>
          <template v-if="Array.isArray(execInfo.executors)">
            <div class="krow" v-for="(ex, xi) in execInfo.executors" :key="xi"><span class="kk">· executor {{ ex.index != null ? ex.index : xi }}</span><span>{{ ex.phase }}<template v-if="ex.ready"> ✓</template><template v-if="ex.image_pulling"> · pulling</template><template v-if="ex.reason"> ({{ ex.reason }})</template><template v-if="ex.node"> @{{ ex.node }}</template></span></div>
          </template>
          <div class="krow" v-if="execInfo.records_output != null"><span class="kk">Records out</span><span>{{ execInfo.records_output }}</span></div>
          <div class="krow" v-if="execInfo.duration_seconds != null"><span class="kk">Duration</span><span>{{ execInfo.duration_seconds }}s</span></div>
          <div class="krow" v-if="execInfo.output_dataset_id"><span class="kk">Output dataset</span><span>{{ execInfo.output_dataset_id }}</span></div>
        </div>
        <h4>Logs</h4>
        <pre class="logs logs-lg">{{ execLogs || '(waiting for logs…)' }}</pre>
        <template v-if="execRows && execRows.rows && execRows.rows.length">
          <h4>Output ({{ execRows.rows.length }} rows{{ execRows.rows.length>10 ? ', showing 10' : '' }})
            <button class="dl" @click="downloadCsv" title="Download this preview as CSV">⬇ CSV</button>
          </h4>
          <div class="out-scroll">
            <table class="ftab"><tr><th v-for="c in execRows.columns" :key="c">{{ c }}</th></tr>
              <tr v-for="(r, ri) in execRows.rows.slice(0,10)" :key="ri"><td v-for="c in execRows.columns" :key="c">{{ r[c] }}</td></tr></table>
          </div>
        </template>
      </div>
    </div>

    <!-- Run modal — choose the input dataset like the demo app's run dialog -->
    <div v-if="showRunModal" class="modal-bg" @click.self="showRunModal=false">
      <div class="modal">
        <h3>▶ Run pipeline</h3>
        <label class="ml">Name<input v-model="wizName" placeholder="pipeline name *"></label>
        <label class="ml">Category<input v-model="wizCategory" placeholder="optional"></label>
        <div class="ml"><strong>Input dataset</strong></div>
        <label class="radio"><input type="radio" value="none" v-model="runMode"> 🚀 No dataset (auto-trigger)</label>
        <label class="radio"><input type="radio" value="existing" v-model="runMode"> 🔢 Existing dataset id</label>
        <input v-if="runMode==='existing'" v-model="wizDatasetId" class="ml" placeholder="dataset id">
        <label class="radio"><input type="radio" value="upload" v-model="runMode"> 📄 Paste CSV</label>
        <textarea v-if="runMode==='upload'" v-model="runCsvText" class="ml" rows="4" placeholder="col1,col2&#10;a,b"></textarea>
        <p class="muted small" v-if="runMode==='none'">A 1-row trigger CSV is attached so a <code>load_csv</code> stage has a row to fan out from. Use this for pipelines that seed from a literal URL.</p>
        <div class="modal-actions">
          <button @click="showRunModal=false">Cancel</button>
          <button class="run" @click="runConfirm">▶ Run</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font: 13px/1.45 system-ui, sans-serif; color: #1f2430; }
.wrap { padding: 10px; }
header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.logo { height: 22px; width: auto; }
.muted { color: #888; }
.row { display: flex; gap: 6px; margin: 6px 0; flex-wrap: wrap; }
.row input[type=password] { flex: 1; }
input, select { padding: 5px 8px; border: 1px solid #d4d7e2; border-radius: 7px; font: inherit; background: #fff; transition: border-color .15s, box-shadow .15s; }
input:focus, select:focus { outline: 0; border-color: #8b85f0; box-shadow: 0 0 0 3px rgba(79,70,229,.15); }
button {
  padding: 5px 10px; border: 1px solid #d0d4e6; border-radius: 7px; cursor: pointer;
  font: inherit; font-weight: 500; color: #2b3040;
  background: linear-gradient(180deg,#ffffff,#f1f2f9);
  box-shadow: 0 1px 1px rgba(20,24,60,.04), inset 0 1px 0 rgba(255,255,255,.6);
  transition: background .15s, border-color .15s, box-shadow .12s, transform .06s;
}
button:hover { background: linear-gradient(180deg,#f6f7fc,#e9ebf7); border-color: #b9bed8; box-shadow: 0 2px 5px rgba(20,24,60,.08); }
button:active { transform: translateY(1px); box-shadow: inset 0 1px 3px rgba(20,24,60,.12); }
button:focus-visible { outline: 0; box-shadow: 0 0 0 3px rgba(79,70,229,.25); }
button.on { background: linear-gradient(180deg,#e9e5ff,#ddd6fe); border-color: #b9a9fb; color: #4c1d95; box-shadow: inset 0 1px 2px rgba(76,29,149,.12); }
button.run {
  background: linear-gradient(135deg,#5b54ec,#7c4fb5); color:#fff; border:0; font-weight: 600;
  box-shadow: 0 2px 8px rgba(79,70,229,.35), inset 0 1px 0 rgba(255,255,255,.25);
}
button.run:hover { background: linear-gradient(135deg,#4f46e5,#6d3fa6); box-shadow: 0 4px 14px rgba(79,70,229,.45); }
button.rec { background: linear-gradient(180deg,#fecdd0,#fca5ab); border-color: #f59aaa; color: #9f1239; font-weight: 600; }
button.rec:hover { background: linear-gradient(180deg,#fdb9bf,#f98a92); }
.status { color: #4f46e5; font-size: 12px; margin: 4px 0; word-break: break-word; }
.small { font-size: 11px; margin: 2px 0 6px; }
.modebar { align-items: center; }
.seg { display: inline-flex; border: 1px solid #c7cbe0; border-radius: 999px; overflow: hidden; padding: 2px; background: #eef0f8; gap: 2px; box-shadow: inset 0 1px 2px rgba(20,24,60,.06); }
.seg button { border: 0; border-radius: 999px; background: transparent; padding: 4px 14px; box-shadow: none; font-weight: 600; color: #5b6072; }
.seg button:hover { background: rgba(255,255,255,.7); box-shadow: none; }
.seg button.active { background: linear-gradient(135deg,#5b54ec,#7c4fb5); color: #fff; box-shadow: 0 2px 6px rgba(79,70,229,.3); }
.seg button.active:hover { background: linear-gradient(135deg,#5b54ec,#7c4fb5); }
.cs { background: #fef3c7; border: 1px solid #fde68a; color: #92400e; border-radius: 8px; padding: 8px; margin: 4px 0 8px; font-size: 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.cs button[disabled] { opacity: .6; }
.cols { display: flex; gap: 10px; align-items: flex-start; }
.palette { width: 140px; flex: none; }
.palette input { width: 100%; margin-bottom: 6px; }
.plist { display: flex; flex-direction: column; gap: 4px; max-height: 74vh; overflow: auto; padding-right: 2px; }
.pitem { text-align: left; font-size: 12px; padding: 6px 9px; border-radius: 8px; }
.pitem:hover { transform: translateX(2px); border-color: #b9a9fb; }
.pcat { display: flex; align-items: center; justify-content: space-between; gap: 4px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: #6b7280; margin: 8px 2px 1px; padding-bottom: 2px; border-bottom: 1px solid #e6e8ef; position: sticky; top: 0; background: #fff; z-index: 1; }
.pcat:first-child { margin-top: 0; }
.pcat-n { font-weight: 600; color: #a8adbd; background: #f1f2f9; border-radius: 999px; padding: 0 6px; font-size: 10px; }
.editor { flex: 1; min-width: 0; }
.pmeta { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.pmeta .name { flex: 1; min-width: 120px; margin: 0; }
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
.modal-bg { position: fixed; inset: 0; background: rgba(15,18,34,.45); display: grid; place-items: center; z-index: 9999; }
.modal { background: #fff; border-radius: 12px; padding: 16px; width: 88%; max-width: 360px; box-shadow: 0 20px 60px rgba(0,0,0,.3); }
.modal h3 { margin: 0 0 10px; }
.modal .ml { display: block; margin: 6px 0; }
.modal .ml input, .modal .ml textarea { width: 100%; }
.modal .radio { display: flex; align-items: center; gap: 6px; margin: 4px 0; font-size: 12px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.modal-lg { max-width: 96%; width: 96%; max-height: 88vh; overflow: auto; }
.modal-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.modal-head .state { font-weight: 700; } .modal-head .state.ok { color: #16a34a; } .modal-head .state.bad { color: #dc2626; }
.logs-lg { max-height: 46vh; }
.out-scroll { max-height: 30vh; overflow: auto; }
.dl { font-size: 11px; margin-left: 8px; font-weight: 400; }
.issues { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; border-radius: 8px; padding: 8px; margin: 6px 0; font-size: 12px; }
.issues ul { margin: 4px 0 0; padding-left: 18px; }
button:disabled { opacity: .5; cursor: not-allowed; }
.exec-chip { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; border-top: 1px solid #e6e8ef; padding-top: 8px; }
.dotst { color: #f59e0b; } .dotst.ok { color: #16a34a; } .dotst.bad { color: #dc2626; }
.kube { background: #f7f8fc; border: 1px solid #e6e8ef; border-radius: 8px; padding: 8px; margin: 4px 0; font-size: 12px; }
.kube .krow { display: flex; gap: 8px; }
.kube .kk { color: #6b7280; min-width: 120px; }
</style>
