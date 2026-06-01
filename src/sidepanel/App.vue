<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { catalogStages, getToken, setToken, startPicker, onPick } from './api.js'

// ── auth (minimal) ──
const token = ref('')
onMounted(async () => { token.value = await getToken() })
async function saveToken() { await setToken(token.value); status.value = 'Token saved.' }

const status = ref('')

// ── stage catalog (palette) ──
const stages = ref([])
const search = ref('')
const loadingCatalog = ref(false)
const filteredStages = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return stages.value
  return stages.value.filter(s =>
    (s.stage_name || '').toLowerCase().includes(q) ||
    (s.description || '').toLowerCase().includes(q))
})

async function loadCatalog() {
  loadingCatalog.value = true
  status.value = 'Loading stage catalog…'
  try {
    const res = await catalogStages()
    stages.value = (res && res.data) ? res.data : (Array.isArray(res) ? res : [])
    status.value = `Loaded ${stages.value.length} stages.`
  } catch (e) {
    status.value = 'Catalog error: ' + e.message
  } finally {
    loadingCatalog.value = false
  }
}

// ── pipeline (editor) ──
const pipeline = ref([])  // [{ stage_name, args, _fields:[] }]
function addStage(s) { pipeline.value.push({ stage_name: s.stage_name, args: [], _fields: [] }) }
function removeStage(i) { pipeline.value.splice(i, 1) }
function moveStage(i, d) {
  const j = i + d
  if (j < 0 || j >= pipeline.value.length) return
  const tmp = pipeline.value[i]; pipeline.value[i] = pipeline.value[j]; pipeline.value[j] = tmp
}

// ── picker → picks (slice 2 binds these to stage fields) ──
const picks = ref([])
let stopPick = null
onMounted(() => { stopPick = onPick((p) => picks.value.unshift(p)) })
onUnmounted(() => { if (stopPick) stopPick() })

async function pick() {
  try { await startPicker('selector-single'); status.value = 'Picker active — click an element on the page.' }
  catch (e) { status.value = 'Picker error: ' + e.message }
}
</script>

<template>
  <div class="app">
    <h1>WebRobot Pipeline Designer</h1>

    <details class="box">
      <summary>Auth token</summary>
      <input v-model="token" placeholder="WebRobot JWT / token" />
      <button @click="saveToken">Save</button>
    </details>

    <div class="row">
      <button @click="loadCatalog" :disabled="loadingCatalog">↻ Load stages</button>
      <button @click="pick">🎯 Pick on page</button>
    </div>

    <p class="status" v-if="status">{{ status }}</p>

    <div class="cols">
      <section class="palette">
        <h2>Stages</h2>
        <input v-model="search" placeholder="filter…" class="filter" />
        <ul>
          <li v-for="s in filteredStages" :key="s.id || s.stage_name" @click="addStage(s)" :title="s.description">
            <code>{{ s.stage_name }}</code>
            <span class="cat" v-if="s.category">{{ s.category }}</span>
          </li>
        </ul>
      </section>

      <section class="pipeline">
        <h2>Pipeline ({{ pipeline.length }})</h2>
        <ol>
          <li v-for="(st, i) in pipeline" :key="i">
            <code>{{ st.stage_name }}</code>
            <span class="ops">
              <button @click="moveStage(i,-1)">↑</button>
              <button @click="moveStage(i,1)">↓</button>
              <button @click="removeStage(i)">✕</button>
            </span>
          </li>
        </ol>
        <p v-if="!pipeline.length" class="muted">Click stages on the left to build the pipeline.</p>
      </section>
    </div>

    <section class="picks" v-if="picks.length">
      <h2>Picks</h2>
      <div class="pick" v-for="(p,i) in picks" :key="i">
        <strong>{{ p.type }}</strong>
        <code v-if="p.selector">{{ p.selector }}</code>
        <div class="muted" v-if="p.sampleText">{{ String(p.sampleText).slice(0,100) }}</div>
      </div>
    </section>

    <p class="todo">Slice 1. Next: bind picks → stage fields, variables, Run → status/logs/output.</p>
  </div>
</template>

<style>
body { margin: 0; }
.app { font: 13px/1.5 system-ui, sans-serif; padding: 10px; }
h1 { font-size: 15px; margin: 0 0 8px; }
h2 { font-size: 13px; margin: 8px 0 4px; }
.box, .row { margin-bottom: 8px; }
.row { display: flex; gap: 8px; }
button { padding: 5px 10px; border: 1px solid #ccc; border-radius: 6px; background: #f6f6f6; cursor: pointer; }
button:hover { background: #eee; }
input { padding: 5px 8px; border: 1px solid #ccc; border-radius: 6px; width: 100%; box-sizing: border-box; }
.filter { margin-bottom: 6px; }
.status { color: #555; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.palette ul, .pipeline ol { list-style: none; padding: 0; margin: 0; max-height: 320px; overflow: auto; }
.palette li { padding: 4px 6px; border: 1px solid #eee; border-radius: 6px; margin: 3px 0; cursor: pointer; display: flex; justify-content: space-between; gap: 6px; }
.palette li:hover { background: #eef4ff; }
.cat { color: #999; font-size: 11px; }
.pipeline li { padding: 4px 6px; border: 1px solid #eee; border-left: 3px solid #3b82f6; border-radius: 6px; margin: 3px 0; display: flex; justify-content: space-between; align-items: center; }
.ops button { padding: 1px 6px; margin-left: 2px; }
.pick { border: 1px solid #eee; border-left: 3px solid #10b981; border-radius: 6px; padding: 5px 7px; margin: 4px 0; }
.muted { color: #999; }
code { word-break: break-all; }
.todo { margin-top: 12px; padding: 6px 8px; background: #fffbe6; border: 1px solid #f0e0a0; border-radius: 6px; color: #7a6a20; }
</style>
