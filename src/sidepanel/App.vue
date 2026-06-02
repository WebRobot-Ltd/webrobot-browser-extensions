<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  catalogStages, getToken, setToken, startPicker, onPick, sendToPicker,
  inferSegment, inferOddsStructure, suggestFieldNames, validatePipeline,
  generatePipeline, executionStatus, executionLogs, executionOutput,
} from './api.js'

/* ──────────────────────────────────────────────────────────────────────────
   WebRobot Pipeline Designer — browser-extension port of DemoApp.vue.
   The side panel IS the app: stage palette, structured editor (extract /
   flatSelect / oddsSelect), on-page picker binding, pipeline-level geo +
   runtime, YAML preview, validate, and Run → status/logs/output.
   Camoufox stays the runtime; picking happens in the REAL page (content script).
   ────────────────────────────────────────────────────────────────────────── */

// ── auth ──
const token = ref('')
const status = ref('')
async function saveToken() { await setToken(token.value); status.value = 'Token saved.' }

// ── stage catalog (palette) ──
const stages = ref([])
const search = ref('')
const loadingCatalog = ref(false)
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return stages.value
  return stages.value.filter(s =>
    (s.stage_name || '').toLowerCase().includes(q) ||
    (s.description || '').toLowerCase().includes(q))
})
async function loadCatalog() {
  loadingCatalog.value = true; status.value = 'Loading stage catalog…'
  try {
    const res = await catalogStages()
    stages.value = (res && res.data) ? res.data : (Array.isArray(res) ? res : [])
    status.value = `Loaded ${stages.value.length} stages.`
  } catch (e) { status.value = 'Catalog error: ' + e.message }
  finally { loadingCatalog.value = false }
}
function specFor(name) {
  return stages.value.find(s => s.stage_name === name || (s.aliases || []).includes(name))
}
function argSchema(name) { const s = specFor(name); return (s && s.arg_schema) || [] }

// ── pipeline model ──  rows: { stage_name, args:{}, _fields:[], _markets:[] }
const pipeline = ref([])
const wizName = ref('extension-pipeline')
function addStage(s) { pipeline.value.push({ stage_name: s.stage_name, args: {}, _fields: [], _markets: [] }) }
function removeStage(i) { pipeline.value.splice(i, 1) }
function moveStage(i, d) {
  const j = i + d; if (j < 0 || j >= pipeline.value.length) return
  const a = pipeline.value; [a[i], a[j]] = [a[j], a[i]]; pipeline.value = [...a]
}
const isStructured = (n) => n === 'extract' || n === 'flatSelect'
const isOdds = (n) => n === 'oddsSelect' || n === 'odds_select'
function segArgName(i) {
  const sch = argSchema(pipeline.value[i].stage_name)
  return (sch.find(a => /segment|selector/i.test(a.name)) || {}).name || 'segmentSelector'
}
function segArgName0(row) {
  const sch = argSchema(row.stage_name)
  return (sch.find(a => /segment|selector/i.test(a.name)) || {}).name || 'segmentSelector'
}

// ── pipeline-level settings ──
const wizGeo = ref('')
const wizRuntime = ref('spark')
const GEO_ZONES = [
  { code: '', label: '🌍 Auto (no geo)' }, { code: 'gb', label: '🇬🇧 UK' },
  { code: 'it', label: '🇮🇹 Italy' }, { code: 'de', label: '🇩🇪 Germany' },
  { code: 'fr', label: '🇫🇷 France' }, { code: 'es', label: '🇪🇸 Spain' },
  { code: 'us', label: '🇺🇸 USA' }, { code: 'nl', label: '🇳🇱 Netherlands' },
]

// ── field / market editing ──
function updateArg(i, name, v) { pipeline.value[i].args[name] = v; pipeline.value = [...pipeline.value] }
function addField(i) { (pipeline.value[i]._fields ||= []).push({ selector: '', as: 'field', method: 'text' }); pipeline.value = [...pipeline.value] }
function updField(i, fi, k, v) { pipeline.value[i]._fields[fi][k] = v; pipeline.value = [...pipeline.value] }
function rmField(i, fi) { pipeline.value[i]._fields.splice(fi, 1); pipeline.value = [...pipeline.value] }
function addMarketField(i, mi) { (pipeline.value[i]._markets[mi].fields ||= []).push({ selector: '', as: 'field', method: 'text' }); pipeline.value = [...pipeline.value] }
function updMarket(i, mi, k, v) { pipeline.value[i]._markets[mi][k] = v; pipeline.value = [...pipeline.value] }
function updMarketField(i, mi, fi, k, v) { pipeline.value[i]._markets[mi].fields[fi][k] = v; pipeline.value = [...pipeline.value] }
function rmMarket(i, mi) { pipeline.value[i]._markets.splice(mi, 1); pipeline.value = [...pipeline.value] }

// ── picker binding ──
const pt = ref(null)        // { stageIdx, kind:'arg'|'field-multi'|'market-box', argName }
let pickTab = null
let stopPick = null
const oddsInferKey = ref(null)

async function beginPick(target, mode) {
  pt.value = target
  try { pickTab = await startPicker(mode); status.value = 'Picker active — click on the page.' }
  catch (e) { status.value = 'Picker error: ' + e.message }
}
const pickArg = (i, name) => beginPick({ stageIdx: i, kind: 'arg', argName: name }, 'selector-single')
const pickFields = (i) => beginPick({ stageIdx: i, kind: 'field-multi' }, 'multi-field')
const pickRowLca = (i, name) => beginPick({ stageIdx: i, kind: 'arg', argName: name }, 'selector-single')
const pickMarketBox = (i) => beginPick({ stageIdx: i, kind: 'market-box' }, 'selector-single')

async function appendMarket(i, selector, html) {
  const m = (pipeline.value[i]._markets ||= [])
  const mi = m.length
  m.push({ label: '', sectionSelector: selector, rowSelector: '', fields: [], enabled: true, _html: html || '' })
  pipeline.value = [...pipeline.value]
  status.value = `Market ${mi + 1} captured — inferring structure…`
  await inferMarket(i, mi)
}
async function inferMarket(i, mi) {
  const m = pipeline.value[i]._markets[mi]; if (!m) return
  oddsInferKey.value = `${i}:${mi}`
  try {
    const j = await inferOddsStructure({ label: m.label || '', section_html: m._html || '' })
    if (j.rowSelector) m.rowSelector = j.rowSelector
    if (Array.isArray(j.fields)) m.fields = j.fields.map(f => ({ selector: f.selector || '', as: f.as || 'field', method: f.method || 'text' }))
    if (!m.label) m.label = 'Market ' + (mi + 1)
    pipeline.value = [...pipeline.value]
    status.value = `Structure suggested for market ${mi + 1}.`
  } catch (e) { status.value = 'AI infer failed: ' + e.message }
  finally { oddsInferKey.value = null }
}

async function handlePick(p) {
  if (!p || !p.type) return
  // The picker asks us to generalise a weak row selector → infer + reply.
  if (p.type === 'webrobot-generalize-request') {
    try {
      const j = await inferSegment({ html: p.html || p.sampleHtmlFull || '', sample_html: p.sampleHtml || '' })
      const sel = j.selector || (j.candidates && j.candidates[0])
      await sendToPicker(pickTab, { type: 'webrobot-generalize-result', selector: sel || '', requestId: p.requestId })
    } catch (_) { await sendToPicker(pickTab, { type: 'webrobot-generalize-result', selector: '', requestId: p.requestId }) }
    return
  }
  if (p.type === 'webrobot-picker-multi-warn') { status.value = p.warn || 'click outside the segment'; return }
  const t = pt.value; if (!t) return
  const row = pipeline.value[t.stageIdx]; if (!row) return

  if (p.type === 'webrobot-pick-selector') {
    if (t.kind === 'market-box') { await appendMarket(t.stageIdx, p.selector, p.sampleHtmlFull || p.sampleHtml || ''); return }
    if (t.kind === 'arg') {
      updateArg(t.stageIdx, t.argName, p.selector)  // row-lca wrapper arrives here too
      status.value = `Set ${t.argName} = ${p.selector}` + (p.matches != null ? ` (${p.matches} matches)` : '')
    }
  } else if (p.type === 'webrobot-pick-multi-field') {
    if (t.kind !== 'field-multi') return
    const fields = (row._fields ||= [])
    const sel = (p.selector || '').trim()
    if (sel && fields.some(f => (f.selector || '').trim() === sel)) { status.value = 'duplicate selector skipped'; return }
    const guess = (() => { const s = (p.sampleText || '').trim(); if (!s || /^\d+([.,]\d+)?$/.test(s)) return 'field_' + (fields.length + 1); return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'field_' + (fields.length + 1) })()
    const attrs = Array.isArray(p.attributes) ? p.attributes : []
    const method = (!p.sampleText && attrs.includes('src')) ? 'attr(src)' : (!p.sampleText && attrs.includes('href')) ? 'attr(href)' : 'text'
    fields.push({ selector: sel, as: guess, method, _parallel: !!p.parallel, _sample: p.sampleText })
    pipeline.value = [...pipeline.value]
  }
}

async function doSuggestNames(i) {
  const f = pipeline.value[i]._fields || []
  if (!f.length) return
  try {
    const j = await suggestFieldNames({ fields: f.map(x => ({ selector: x.selector, sample: x._sample || '' })) })
    if (Array.isArray(j.names)) j.names.forEach((n, k) => { if (f[k] && n) f[k].as = n })
    pipeline.value = [...pipeline.value]; status.value = 'Column names suggested.'
  } catch (e) { status.value = 'suggest-names failed: ' + e.message }
}

// ── YAML generation (ported from DemoApp.buildYamlFromPipeline) ──
function yamlScalar(v) {
  const s = String(v ?? '')
  if (s === '') return '""'
  if (/[:#{}\[\],&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s)
  return s
}
const wizYaml = computed(() => buildYaml())
function buildYaml() {
  const p = pipeline.value
  if (!p.length) return '(add at least one stage)'
  const lines = ['pipeline:']
  for (const row of p) {
    const fields = (row._fields || []).filter(f => (f.selector || '').trim())
    const flatSplit = row.stage_name === 'flatSelect' && fields.some(f => f._parallel)
    lines.push(`  - stage: ${flatSplit ? 'parallelSelect' : row.stage_name}`)

    if (flatSplit) {
      const seg = row.args[segArgName0(row)] || ''
      lines.push('    args:'); lines.push('      -')
      for (const f of fields) {
        const sel = f._parallel ? f.selector : (seg ? `${seg} ${f.selector}` : f.selector)
        lines.push(`        - { selector: ${yamlScalar(sel)}, method: ${yamlScalar(f.method || 'text')}, as: ${yamlScalar(f.as || '')} }`)
      }
      continue
    }
    if (row.stage_name === 'extract') {
      if (!fields.length) lines.push('    args: []')
      else { lines.push('    args:'); for (const f of fields) lines.push(`      - { selector: ${yamlScalar(f.selector)}, method: ${yamlScalar(f.method || 'text')}, as: ${yamlScalar(f.as || '')} }`) }
      continue
    }
    if (row.stage_name === 'flatSelect') {
      const seg = row.args[segArgName0(row)] || ''
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
    // generic: positional args from arg_schema
    const sch = argSchema(row.stage_name)
    const filled = sch.map(a => [a.name, row.args[a.name]]).filter(([, v]) => v != null && v !== '')
    if (!filled.length) lines.push('    args: []')
    else { lines.push('    args:'); for (const [n, v] of filled) lines.push(`      - ${yamlScalar(v)}    # ${n}`) }
  }
  lines.push('output:'); lines.push('  format: parquet'); lines.push('  mode: overwrite')
  const meta = []
  if (wizRuntime.value && wizRuntime.value !== 'spark') meta.push(`  runtime: ${yamlScalar(wizRuntime.value)}`)
  if (wizGeo.value && /^[a-z]{2}$/i.test(wizGeo.value)) meta.push(`  geo: ${yamlScalar(wizGeo.value.toLowerCase())}`)
  if (meta.length) { lines.push('metadata:'); meta.forEach(m => lines.push(m)) }
  return lines.join('\n')
}

// ── validate ──
const validating = ref(false)
async function doValidate() {
  validating.value = true; status.value = 'Validating…'
  try {
    const j = await validatePipeline({ pipeline_yaml: wizYaml.value })
    status.value = j.ok === false ? ('Validation failed: ' + (j.error || JSON.stringify(j))) : `Validation OK (${(j.records || []).length} preview rows).`
  } catch (e) { status.value = 'Validate error: ' + e.message }
  finally { validating.value = false }
}

// ── run → poll ──
const running = ref(false)
const execId = ref('')
const execState = ref('')
const execLogs = ref('')
const execRows = ref(null)
let pollTimer = null
async function run() {
  running.value = true; execRows.value = null; execLogs.value = ''; execState.value = 'submitting'
  status.value = 'Submitting pipeline…'
  try {
    const j = await generatePipeline({ pipeline_name: wizName.value, pipeline_yaml: wizYaml.value, execute: true })
    const id = j.execution_id || j.executionId || j.id || (j.execution && j.execution.id)
    if (!id) throw new Error('no execution id in response')
    execId.value = id; status.value = 'Running ' + id
    poll()
  } catch (e) { running.value = false; execState.value = 'error'; status.value = 'Run error: ' + e.message }
}
async function poll() {
  try {
    const s = await executionStatus(execId.value)
    execState.value = s.status || s.state || JSON.stringify(s)
    const done = /SUCCEED|COMPLETE|FAIL|ERROR|KILLED/i.test(execState.value)
    try { const l = await executionLogs(execId.value); execLogs.value = (typeof l === 'string' ? l : (l.logs || JSON.stringify(l))).slice(-4000) } catch (_) {}
    if (done) {
      running.value = false
      if (/SUCCEED|COMPLETE/i.test(execState.value)) { try { execRows.value = await executionOutput(execId.value) } catch (_) {} }
      return
    }
    pollTimer = setTimeout(poll, 3000)
  } catch (e) { running.value = false; execState.value = 'error'; status.value = 'Poll error: ' + e.message }
}

onMounted(async () => { token.value = await getToken(); stopPick = onPick((p) => handlePick(p)); loadCatalog() })
onUnmounted(() => { stopPick && stopPick(); pollTimer && clearTimeout(pollTimer) })
</script>

<template>
  <div class="wrap">
    <header><strong>WebRobot Designer</strong><span class="muted">extension</span></header>

    <div class="row">
      <input v-model="token" type="password" placeholder="API token" />
      <button @click="saveToken">Save</button>
      <button @click="loadCatalog" :disabled="loadingCatalog">↻ Stages</button>
    </div>
    <p class="status" v-if="status">{{ status }}</p>

    <div class="cols">
      <!-- palette -->
      <section class="palette">
        <input v-model="search" placeholder="filter stages…" />
        <div class="plist">
          <button v-for="s in filtered" :key="s.stage_name" class="pitem" :title="s.description" @click="addStage(s)">{{ s.stage_name }}</button>
        </div>
      </section>

      <!-- editor -->
      <section class="editor">
        <input v-model="wizName" class="name" placeholder="pipeline name" />
        <p v-if="!pipeline.length" class="muted">Click stages to build the pipeline.</p>

        <div v-for="(row, i) in pipeline" :key="i" class="stage">
          <div class="shead">
            <strong>{{ i + 1 }}. {{ row.stage_name }}</strong><span class="sp"></span>
            <button @click="moveStage(i,-1)" :disabled="i===0">↑</button>
            <button @click="moveStage(i,1)" :disabled="i===pipeline.length-1">↓</button>
            <button @click="removeStage(i)">✕</button>
          </div>

          <template v-if="isStructured(row.stage_name)">
            <div v-if="row.stage_name==='flatSelect'" class="argrow">
              <label>{{ segArgName(i) }}</label>
              <input :value="row.args[segArgName(i)]||''" @input="updateArg(i, segArgName(i), $event.target.value)" placeholder="row/segment selector" />
              <button @click="pickArg(i, segArgName(i))" title="pick">🎯</button>
              <button @click="pickRowLca(i, segArgName(i))" title="2-click row wrapper">🧩</button>
            </div>
            <div class="fhead">
              <strong>Fields ({{ (row._fields||[]).length }})</strong>
              <button @click="pickFields(i)">🎯 Pick fields</button>
              <button @click="addField(i)">+ field</button>
              <button @click="doSuggestNames(i)" :disabled="!(row._fields||[]).length">🪄 names</button>
            </div>
            <table v-if="(row._fields||[]).length" class="ftab">
              <tr v-for="(f, fi) in row._fields" :key="fi">
                <td><input :value="f.as" @input="updField(i,fi,'as',$event.target.value)" placeholder="col"/></td>
                <td><input :value="f.method" @input="updField(i,fi,'method',$event.target.value)" placeholder="text"/></td>
                <td><input :value="f.selector" @input="updField(i,fi,'selector',$event.target.value)" placeholder="selector"/></td>
                <td><span v-if="f._parallel" title="picked outside segment → parallelSelect">∥</span></td>
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
                <input :value="m.label" @input="updMarket(i,mi,'label',$event.target.value)" placeholder="market label"/>
                <button @click="inferMarket(i,mi)" :disabled="oddsInferKey===(i+':'+mi)" title="AI infer">🪄</button>
                <button @click="rmMarket(i,mi)">✕</button>
              </div>
              <input :value="m.sectionSelector" @input="updMarket(i,mi,'sectionSelector',$event.target.value)" placeholder="section selector"/>
              <input :value="m.rowSelector" @input="updMarket(i,mi,'rowSelector',$event.target.value)" placeholder="row selector (relative)"/>
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
              <button v-if="/selector|url/i.test(a.name)" @click="pickArg(i,a.name)">🎯</button>
            </div>
            <p v-if="!argSchema(row.stage_name).length" class="muted">no args</p>
          </template>
        </div>

        <div v-if="pipeline.length" class="settings">
          <label>🌍 Geo <select v-model="wizGeo"><option v-for="z in GEO_ZONES" :key="z.code" :value="z.code">{{ z.label }}</option></select></label>
          <label>🖥 Runtime <select v-model="wizRuntime"><option value="spark">Spark</option><option value="ray_actor">Ray actor</option></select></label>
          <p v-if="wizRuntime==='ray_actor'" class="warn">🚧 Ray actor under design (Phase-4) — records metadata.runtime but runs on Spark for now.</p>
        </div>

        <div v-if="pipeline.length">
          <h4>YAML</h4>
          <pre class="yaml">{{ wizYaml }}</pre>
          <div class="row">
            <button @click="doValidate" :disabled="validating">✓ Validate</button>
            <button class="run" @click="run" :disabled="running">▶ Run</button>
          </div>
        </div>

        <div v-if="execId" class="exec">
          <div><strong>{{ execId }}</strong> — <span :class="{ok:/SUCCEED|COMPLETE/i.test(execState), bad:/FAIL|ERROR|KILLED/i.test(execState)}">{{ execState }}</span></div>
          <pre v-if="execLogs" class="logs">{{ execLogs }}</pre>
          <div v-if="execRows && execRows.rows && execRows.rows.length" class="out">
            <table class="ftab">
              <tr><th v-for="c in execRows.columns" :key="c">{{ c }}</th></tr>
              <tr v-for="(r, ri) in execRows.rows.slice(0,10)" :key="ri"><td v-for="c in execRows.columns" :key="c">{{ r[c] }}</td></tr>
            </table>
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
button { padding: 4px 8px; border: 1px solid #c7cbe0; background: #f3f4fb; border-radius: 6px; cursor: pointer; }
button:hover { background: #e9ebf7; }
button.run { background: linear-gradient(135deg,#4f46e5,#764ba2); color:#fff; border:0; }
.status { color: #4f46e5; font-size: 12px; margin: 4px 0; }
.cols { display: flex; gap: 10px; align-items: flex-start; }
.palette { width: 150px; flex: none; }
.palette input { width: 100%; margin-bottom: 6px; }
.plist { display: flex; flex-direction: column; gap: 3px; max-height: 72vh; overflow: auto; }
.pitem { text-align: left; font-size: 12px; }
.editor { flex: 1; min-width: 0; }
.name { width: 100%; margin-bottom: 6px; font-weight: 600; }
.stage { border: 1px solid #e6e8ef; border-radius: 8px; padding: 8px; margin-bottom: 8px; }
.shead { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; }
.sp { flex: 1; }
.argrow { display: flex; align-items: center; gap: 4px; margin: 3px 0; }
.argrow label { font-size: 11px; min-width: 70px; color: #555; }
.argrow input { flex: 1; }
.fhead { display: flex; align-items: center; gap: 6px; margin: 6px 0 4px; flex-wrap: wrap; }
.ftab { width: 100%; border-collapse: collapse; }
.ftab td, .ftab th { padding: 1px; text-align: left; }
.ftab input { width: 100%; }
.market { border: 1px solid #eee; border-left: 3px solid #f59e0b; border-radius: 6px; padding: 6px; margin: 4px 0; }
.market.off { opacity: .5; }
.market > input { width: 100%; margin: 2px 0; }
.mhead { display: flex; gap: 4px; align-items: center; }
.mhead input[type=text], .mhead input:not([type]) { flex: 1; }
.settings { background: #f7f8fc; border: 1px solid #e6e8ef; border-radius: 8px; padding: 8px; margin: 8px 0; }
.settings label { margin-right: 12px; }
.warn { color: #92400e; background: #fef3c7; border-radius: 6px; padding: 6px; margin: 6px 0 0; font-size: 12px; }
.yaml { background: #0d0f1c; color: #d4d4d4; padding: 10px; border-radius: 8px; overflow-x: auto; font: 11px/1.5 ui-monospace, monospace; white-space: pre; }
.exec { margin-top: 8px; border-top: 1px solid #e6e8ef; padding-top: 8px; }
.exec .ok { color: #16a34a; font-weight: 700; }
.exec .bad { color: #dc2626; font-weight: 700; }
.logs { background: #111; color: #9fe; padding: 8px; border-radius: 6px; max-height: 180px; overflow: auto; font: 11px/1.4 ui-monospace, monospace; }
h4 { margin: 8px 0 4px; }
</style>
