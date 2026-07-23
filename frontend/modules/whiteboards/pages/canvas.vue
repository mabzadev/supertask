<template>
  <div class="whiteboard" :class="{ 'whiteboard--offline': !online }">
    <header class="whiteboard__header">
      <div class="whiteboard__identity">
        <span class="whiteboard__icon">{{ canvas?.icon || '🧠' }}</span>
        <input v-model="name" class="whiteboard__name" :placeholder="$t('whiteboards.untitled')" @input="scheduleSave" />
      </div>
      <div class="whiteboard__status">
        <span :class="{ 'whiteboard__status-dot--offline': !online }" class="whiteboard__status-dot"></span>
        {{ !online ? $t('whiteboards.offline') : saving ? $t('whiteboards.saving') : $t('whiteboards.saved') }}
      </div>
      <div class="whiteboard__presence" aria-label="Personnes présentes">
        <span v-for="person in visiblePeople" :key="person.clientId" class="whiteboard__avatar" :style="{ background: person.color }" :title="person.name">{{ initials(person.name) }}</span>
      </div>
      <div class="whiteboard__actions">
        <button class="whiteboard__button" :disabled="!canUndo" title="Annuler (⌘Z)" @click="undo"><i class="iconoir-undo"></i></button>
        <button class="whiteboard__button" :disabled="!canRedo" title="Rétablir (⇧⌘Z)" @click="redo"><i class="iconoir-redo"></i></button>
        <div class="whiteboard__menu-wrap">
          <button class="whiteboard__button" title="Organiser la sélection" @click="arrangeOpen = !arrangeOpen"><i class="iconoir-align-left"></i></button>
          <div v-if="arrangeOpen" class="whiteboard__menu whiteboard__menu--arrange">
            <button @click="alignLeft">Aligner à gauche</button>
            <button @click="distributeHorizontal">Distribuer horizontalement</button>
            <button @click="distributeVertical">Distribuer verticalement</button>
            <button @click="bringForward">Mettre au premier plan</button>
            <button @click="sendBackward">Mettre à l’arrière-plan</button>
            <button @click="toggleLock">{{ selectedNodes().every((node) => node.draggable === false) ? 'Déverrouiller' : 'Verrouiller' }}</button>
          </div>
        </div>
        <button class="whiteboard__button whiteboard__button--text" @click="commentsOpen = !commentsOpen"><i class="iconoir-chat-bubble"></i> Commentaires</button>
        <div class="whiteboard__menu-wrap">
          <button class="whiteboard__button" title="Menu du canevas" @click="menuOpen = !menuOpen"><i class="iconoir-more-horiz"></i></button>
          <div v-if="menuOpen" class="whiteboard__menu">
            <button @click="createVersion">Créer une version nommée</button>
            <button @click="openVersions">Historique et versions</button>
            <button @click="exportPng">Exporter en PNG</button>
            <button @click="printPdf">Exporter en PDF</button>
            <button @click="duplicateCanvas">Dupliquer le canevas</button>
          </div>
        </div>
      </div>
    </header>

    <main ref="stage" class="whiteboard__stage" @pointerdown="stagePointerDown" @pointermove="stagePointerMove" @pointerup="stagePointerUp">
      <VueFlow
        v-model:nodes="nodes"
        v-model:edges="edges"
        class="whiteboard__flow"
        :class="`whiteboard__flow--${tool}`"
        :nodes-draggable="tool === 'select'"
        :nodes-connectable="tool === 'connector' || tool === 'select'"
        :pan-on-drag="tool === 'hand' ? true : [1]"
        :selection-on-drag="tool === 'select'"
        :multi-selection-key-code="['Meta', 'Shift']"
        :zoom-on-pinch="true"
        :min-zoom="0.15"
        :max-zoom="4"
        fit-view-on-init
        @connect="onConnect"
        @nodes-change="stateChanged"
        @edges-change="stateChanged"
        @node-click="nodeClicked"
        @pane-click="paneClicked"
      >
        <Background pattern-color="#d8d7e4" :gap="24" :size="1" />
        <Controls position="bottom-right" />
        <template #node-sticky="props"><BoardNode v-bind="props" kind="sticky" @change="updateNodeText" /></template>
        <template #node-text="props"><BoardNode v-bind="props" kind="text" @change="updateNodeText" /></template>
        <template #node-shape="props"><BoardNode v-bind="props" kind="shape" @change="updateNodeText" /></template>
        <template #node-frame="props"><BoardNode v-bind="props" kind="frame" @change="updateNodeText" /></template>
        <template #node-image="props"><BoardNode v-bind="props" kind="image" @change="updateNodeText" /></template>
      </VueFlow>
      <svg v-if="strokes.length || drawing" class="whiteboard__drawing-layer">
        <polyline v-for="stroke in strokes" :key="stroke.id" :points="stroke.points.map(point => `${point.x},${point.y}`).join(' ')" fill="none" :stroke="stroke.color || '#24232a'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        <polyline v-if="drawing" :points="drawing.points.map(point => `${point.x},${point.y}`).join(' ')" fill="none" stroke="#5547d7" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div v-if="!nodes.length && !strokes.length" class="whiteboard__welcome">
        <div class="whiteboard__welcome-icon">✦</div>
        <h2>Donnez vie à vos idées</h2>
        <p>Choisissez un outil ou partez d’un modèle simple.</p>
        <div class="whiteboard__templates">
          <button v-for="template in templates" :key="template.id" @click.stop="applyTemplate(template.id)">
            <span>{{ template.icon }}</span>{{ template.label }}
          </button>
        </div>
      </div>
      <div v-for="person in remoteCursors" :key="person.clientId" class="whiteboard__remote-cursor" :style="{ transform: `translate(${person.cursor.x}px, ${person.cursor.y}px)`, color: person.color }">
        <i class="iconoir-cursor-pointer-solid"></i><span :style="{ background: person.color }">{{ person.name }}</span>
      </div>
    </main>

    <nav class="whiteboard__toolbar" aria-label="Outils du tableau blanc">
      <button v-for="item in tools" :key="item.id" :class="{ active: tool === item.id }" :title="item.label" @click="chooseTool(item.id)">
        <i :class="item.icon"></i><span>{{ item.short }}</span>
      </button>
      <button title="Ajouter une image" @click="imageInput?.click()"><i class="iconoir-media-image"></i><span>Image</span></button>
      <input ref="imageInput" hidden type="file" accept="image/*" @change="uploadImage" />
    </nav>

    <CollaborationPanel v-if="commentsOpen" kind="whiteboard-canvas" :content-id="canvasId" :anchor="commentAnchor" @close="commentsOpen = false" />
    <VersionPanel v-if="versionsOpen" kind="whiteboard-canvas" :content-id="canvasId" @close="versionsOpen = false" @restored="reloadCanvas" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useStore } from 'vuex'
import { useNuxtApp, useRuntimeConfig } from '#imports'
import { VueFlow, addEdge } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import BoardNode from '@baserow/modules/whiteboards/components/BoardNode.vue'
import CollaborationPanel from '@baserow/modules/core/components/collaboration/CollaborationPanel.vue'
import VersionPanel from '@baserow/modules/core/components/collaboration/VersionPanel.vue'
import UserFileService from '@baserow/modules/core/services/userFile'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'

const route = useRoute()
const router = useRouter()
const store = useStore()
const nuxtApp = useNuxtApp()
const config = useRuntimeConfig()
const whiteboardId = computed(() => Number(route.params.whiteboardId))
const canvasId = computed(() => Number(route.params.canvasId))
const canvas = computed(() => store.getters['whiteboardCanvas/get'](canvasId.value))
const name = ref(canvas.value?.name || '')
const nodes = ref(cloneValue(canvas.value?.state?.nodes || []))
const edges = ref(cloneValue(canvas.value?.state?.edges || []))
const strokes = ref(cloneValue(canvas.value?.state?.strokes || []))
const tool = ref('select')
const saving = ref(false)
const online = ref(true)
const menuOpen = ref(false)
const arrangeOpen = ref(false)
const commentsOpen = ref(false)
const versionsOpen = ref(false)
const people = ref([])
const stage = ref(null)
const imageInput = ref(null)
const drawing = ref(null)
const saveTimer = ref(null)
const history = ref([])
const future = ref([])
let ydoc
let provider
let persistence
let applyingRemote = false
let historyLocked = false
let copiedNodes = []

const tools = [
  { id: 'select', label: 'Sélection (V)', short: 'Sélection', icon: 'iconoir-cursor-pointer' },
  { id: 'hand', label: 'Main (H)', short: 'Main', icon: 'iconoir-hand' },
  { id: 'text', label: 'Texte (T)', short: 'Texte', icon: 'iconoir-text' },
  { id: 'sticky', label: 'Note autocollante (N)', short: 'Note', icon: 'iconoir-post' },
  { id: 'rectangle', label: 'Rectangle (R)', short: 'Forme', icon: 'iconoir-square' },
  { id: 'ellipse', label: 'Ellipse (O)', short: 'Ellipse', icon: 'iconoir-circle' },
  { id: 'diamond', label: 'Losange (D)', short: 'Losange', icon: 'iconoir-diamond' },
  { id: 'connector', label: 'Connecteur (C)', short: 'Flèche', icon: 'iconoir-arrow-right' },
  { id: 'draw', label: 'Dessin libre (P)', short: 'Dessin', icon: 'iconoir-edit-pencil' },
  { id: 'frame', label: 'Cadre (F)', short: 'Cadre', icon: 'iconoir-frame' },
]
const templates = [
  { id: 'brainstorming', label: 'Brainstorming', icon: '💡' },
  { id: 'flowchart', label: 'Organigramme', icon: '🔀' },
  { id: 'retrospective', label: 'Rétrospective', icon: '↩️' },
  { id: 'project', label: 'Plan de projet', icon: '🗂️' },
]
const canUndo = computed(() => history.value.length > 0)
const canRedo = computed(() => future.value.length > 0)
const visiblePeople = computed(() => people.value.slice(0, 5))
const remoteCursors = computed(() => people.value.filter((person) => person.cursor))
const commentAnchor = computed(() => {
  const selected = selectedNodes()
  return selected.length === 1 ? { type: 'whiteboard-object', object_id: selected[0].id, label: selected[0].data?.text || 'Objet' } : { type: 'canvas' }
})

function cloneValue(value) { return JSON.parse(JSON.stringify(value)) }
function snapshot() { return cloneValue({ nodes: nodes.value, edges: edges.value, strokes: strokes.value }) }
function pushHistory() {
  if (historyLocked || applyingRemote) return
  history.value.push(snapshot())
  if (history.value.length > 80) history.value.shift()
  future.value = []
}
function applySnapshot(value) {
  historyLocked = true
  nodes.value = cloneValue(value.nodes || [])
  edges.value = cloneValue(value.edges || [])
  strokes.value = cloneValue(value.strokes || [])
  setTimeout(() => { historyLocked = false; scheduleSave() })
}
function undo() { if (!canUndo.value) return; future.value.push(snapshot()); applySnapshot(history.value.pop()) }
function redo() { if (!canRedo.value) return; history.value.push(snapshot()); applySnapshot(future.value.pop()) }
function chooseTool(value) { tool.value = value }

function pointerPosition(event) {
  const rect = stage.value.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}
function stagePointerDown(event) {
  if (tool.value !== 'draw' || event.button !== 0) return
  event.preventDefault()
  pushHistory()
  drawing.value = { id: crypto.randomUUID(), points: [pointerPosition(event)], color: '#5547d7' }
}
function stagePointerMove(event) { if (drawing.value) drawing.value.points.push(pointerPosition(event)) }
function stagePointerUp() {
  if (!drawing.value) return
  strokes.value.push(drawing.value)
  drawing.value = null
  scheduleSave()
}
function paneClicked(event) {
  if (!['text', 'sticky', 'rectangle', 'ellipse', 'diamond', 'frame'].includes(tool.value)) return
  pushHistory()
  const position = pointerPosition(event.event || event)
  const kind = tool.value === 'text' ? 'text' : tool.value === 'sticky' ? 'sticky' : tool.value === 'frame' ? 'frame' : 'shape'
  nodes.value.push({
    id: crypto.randomUUID(), type: kind, position,
    data: { text: kind === 'sticky' ? 'Nouvelle idée' : kind === 'frame' ? 'Nouveau cadre' : kind === 'text' ? 'Saisissez votre texte' : 'Forme', shape: tool.value, color: kind === 'sticky' ? 'yellow' : 'violet', width: kind === 'frame' ? 360 : 180, height: kind === 'frame' ? 260 : 100 },
  })
  tool.value = 'select'
  scheduleSave()
}
function onConnect(connection) { pushHistory(); edges.value = addEdge({ ...connection, type: 'smoothstep', markerEnd: 'arrowclosed' }, edges.value); scheduleSave() }
function nodeClicked() {}
function stateChanged() { scheduleSave() }
function updateNodeText({ id, text }) {
  const node = nodes.value.find((item) => item.id === id)
  if (node) { node.data = { ...node.data, text }; scheduleSave() }
}
function selectedNodes() { return nodes.value.filter((node) => node.selected) }
function alignLeft() {
  const selected = selectedNodes(); if (selected.length < 2) return
  pushHistory(); const x = Math.min(...selected.map((node) => node.position.x)); selected.forEach((node) => { node.position.x = x }); arrangeOpen.value = false; scheduleSave()
}
function distribute(axis) {
  const selected = [...selectedNodes()].sort((a, b) => a.position[axis] - b.position[axis]); if (selected.length < 3) return
  pushHistory(); const first = selected[0].position[axis]; const last = selected[selected.length - 1].position[axis]; const gap = (last - first) / (selected.length - 1)
  selected.forEach((node, index) => { node.position[axis] = first + gap * index }); arrangeOpen.value = false; scheduleSave()
}
function distributeHorizontal() { distribute('x') }
function distributeVertical() { distribute('y') }
function bringForward() { const selected = selectedNodes(); if (!selected.length) return; pushHistory(); const top = Math.max(0, ...nodes.value.map((node) => Number(node.zIndex) || 0)) + 1; selected.forEach((node, index) => { node.zIndex = top + index }); arrangeOpen.value = false; scheduleSave() }
function sendBackward() { const selected = selectedNodes(); if (!selected.length) return; pushHistory(); const bottom = Math.min(0, ...nodes.value.map((node) => Number(node.zIndex) || 0)) - selected.length; selected.forEach((node, index) => { node.zIndex = bottom + index }); arrangeOpen.value = false; scheduleSave() }
function toggleLock() { const selected = selectedNodes(); if (!selected.length) return; pushHistory(); const lock = !selected.every((node) => node.draggable === false); selected.forEach((node) => { node.draggable = !lock; node.selectable = true }); arrangeOpen.value = false; scheduleSave() }

function syncToYjs() {
  if (!ydoc || applyingRemote) return
  const nodeMap = ydoc.getMap('whiteboard-nodes')
  const edgeMap = ydoc.getMap('whiteboard-edges')
  const strokeMap = ydoc.getMap('whiteboard-strokes')
  ydoc.transact(() => {
    const syncMap = (map, values) => {
      const wanted = new Set(values.map((item) => item.id))
      for (const key of map.keys()) if (!wanted.has(key)) map.delete(key)
      values.forEach((item) => map.set(item.id, cloneValue(item)))
    }
    syncMap(nodeMap, nodes.value); syncMap(edgeMap, edges.value); syncMap(strokeMap, strokes.value)
    ydoc.getMap('opentabl').set('materialized', { name: name.value, icon: canvas.value?.icon || '🧠', state: snapshot(), settings: {}, editor_schema_version: 1 })
  }, 'local-ui')
}
function applyFromYjs() {
  if (!ydoc) return
  const read = (key) => [...ydoc.getMap(key).values()].map((item) => cloneValue(item))
  const remoteNodes = read('whiteboard-nodes')
  const remoteEdges = read('whiteboard-edges')
  const remoteStrokes = read('whiteboard-strokes')
  if (!remoteNodes.length && !remoteEdges.length && !remoteStrokes.length && (nodes.value.length || edges.value.length || strokes.value.length)) {
    syncToYjs(); return
  }
  applyingRemote = true
  nodes.value = remoteNodes; edges.value = remoteEdges; strokes.value = remoteStrokes
  const materialized = ydoc.getMap('opentabl').get('materialized')
  if (materialized?.name && materialized.name !== name.value) name.value = materialized.name
  setTimeout(() => { applyingRemote = false })
}
function scheduleSave() {
  if (applyingRemote) return
  syncToYjs()
  clearTimeout(saveTimer.value)
  saving.value = true
  saveTimer.value = setTimeout(saveRest, 700)
}
async function saveRest() {
  try {
    await store.dispatch('whiteboardCanvas/update', { id: canvasId.value, values: { name: name.value, state: snapshot(), editor_schema_version: 1 } })
  } finally { saving.value = false }
}
async function applyTemplate(template) {
  pushHistory()
  const created = await store.dispatch('whiteboardCanvas/create', { whiteboardId: whiteboardId.value, values: { name: templates.find((item) => item.id === template)?.label, template } })
  router.push({ name: 'whiteboard-canvas', params: { whiteboardId: whiteboardId.value, canvasId: created.id } })
}
async function uploadImage(event) {
  const file = event.target.files?.[0]; if (!file) return
  const { data } = await UserFileService(nuxtApp.$client).uploadFile(file)
  const uploaded = data.user_file || data
  pushHistory()
  nodes.value.push({ id: crypto.randomUUID(), type: 'image', position: { x: 180, y: 140 }, data: { text: file.name, src: uploaded.url || uploaded.original_name, width: 320, height: 220 } })
  scheduleSave(); event.target.value = ''
}
async function createVersion() {
  const label = window.prompt('Nom de la version', `Version du ${new Date().toLocaleString('fr-FR')}`)
  if (label) await nuxtApp.$client.post(`/collaboration/whiteboard-canvas/${canvasId.value}/versions/`, { name: label })
  menuOpen.value = false
}
function openVersions() { menuOpen.value = false; versionsOpen.value = true }
async function reloadCanvas() { await store.dispatch('whiteboardCanvas/fetch', canvasId.value); window.location.reload() }
async function duplicateCanvas() {
  const copy = await store.dispatch('whiteboardCanvas/duplicate', canvasId.value)
  router.push({ name: 'whiteboard-canvas', params: { whiteboardId: whiteboardId.value, canvasId: copy.id } })
}
function renderCanvas() {
  const output = document.createElement('canvas'); output.width = 1600; output.height = 1000
  const context = output.getContext('2d'); context.fillStyle = '#f8f8fb'; context.fillRect(0, 0, output.width, output.height)
  edges.value.forEach((edge) => {
    const a = nodes.value.find((node) => node.id === edge.source); const b = nodes.value.find((node) => node.id === edge.target); if (!a || !b) return
    context.strokeStyle = '#77738f'; context.beginPath(); context.moveTo(a.position.x + 90, a.position.y + 50); context.lineTo(b.position.x + 90, b.position.y + 50); context.stroke()
  })
  nodes.value.forEach((node) => {
    const width = node.data?.width || 180; const height = node.data?.height || 100
    context.fillStyle = node.type === 'sticky' ? '#fff2a8' : '#ffffff'; context.strokeStyle = '#ccc9dc'; context.lineWidth = 2
    context.fillRect(node.position.x, node.position.y, width, height); context.strokeRect(node.position.x, node.position.y, width, height)
    context.fillStyle = '#24232a'; context.font = '18px sans-serif'; context.fillText(String(node.data?.text || ''), node.position.x + 14, node.position.y + 32, width - 28)
  })
  strokes.value.forEach((stroke) => { context.beginPath(); stroke.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); context.strokeStyle = stroke.color; context.lineWidth = 3; context.stroke() })
  return output
}
function exportPng() { const link = document.createElement('a'); link.download = `${name.value || 'tableau-blanc'}.png`; link.href = renderCanvas().toDataURL('image/png'); link.click(); menuOpen.value = false }
function printPdf() { menuOpen.value = false; window.print() }

function keyboard(event) {
  const target = event.target
  if (target?.matches?.('input, textarea, [contenteditable="true"]')) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
  const shortcuts = { v: 'select', h: 'hand', t: 'text', n: 'sticky', r: 'rectangle', o: 'ellipse', d: 'diamond', c: 'connector', p: 'draw', f: 'frame' }
  if (shortcuts[event.key.toLowerCase()]) tool.value = shortcuts[event.key.toLowerCase()]
  if ((event.key === 'Backspace' || event.key === 'Delete') && selectedNodes().length) {
    pushHistory(); const ids = new Set(selectedNodes().map((node) => node.id)); nodes.value = nodes.value.filter((node) => !ids.has(node.id)); edges.value = edges.value.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)); scheduleSave()
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && selectedNodes().length) {
    event.preventDefault(); pushHistory(); const copies = selectedNodes().map((node) => ({ ...cloneValue(node), id: crypto.randomUUID(), position: { x: node.position.x + 28, y: node.position.y + 28 }, selected: false })); nodes.value.push(...copies); scheduleSave()
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && selectedNodes().length) {
    copiedNodes = cloneValue(selectedNodes()); event.preventDefault()
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v' && copiedNodes.length) {
    event.preventDefault(); pushHistory(); const copies = copiedNodes.map((node) => ({ ...node, id: crypto.randomUUID(), draggable: node.draggable !== false, position: { x: node.position.x + 32, y: node.position.y + 32 }, selected: false })); nodes.value.push(...copies); copiedNodes = cloneValue(copies); scheduleSave()
  }
}

function initials(value) { return String(value || '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() }
function userColor() { const colors = ['#6658d9','#d0587e','#238b70','#c0782b','#3976c6']; return colors[(store.getters['auth/getUserId'] || 0) % colors.length] }
function refreshPresence() {
  if (!provider?.awareness) return
  const localId = provider.awareness.clientID
  people.value = [...provider.awareness.getStates().entries()].filter(([clientId]) => clientId !== localId).map(([clientId, state]) => ({ clientId, ...(state.user || {}), cursor: state.cursor || null })).filter((person) => person.name)
}
function publishCursor(event) {
  if (!provider?.awareness || !stage.value) return
  const rect = stage.value.getBoundingClientRect()
  provider.awareness.setLocalStateField('cursor', { x: event.clientX - rect.left, y: event.clientY - rect.top })
}

onMounted(() => {
  online.value = navigator.onLine
  window.addEventListener('online', () => { online.value = true })
  window.addEventListener('offline', () => { online.value = false })
  window.addEventListener('keydown', keyboard)
  ydoc = new Y.Doc()
  persistence = new IndexeddbPersistence(`opentabl:whiteboard:${canvasId.value}`, ydoc)
  const backend = config.public.publicBackendUrl || window.location.origin
  const wsUrl = backend.replace(/^http/, 'ws') + `/ws/collaboration/whiteboard-canvas/${canvasId.value}/?editor_schema_version=1&jwt_token=${encodeURIComponent(store.getters['auth/token'] || '')}`
  provider = new HocuspocusProvider({ url: wsUrl, name: `whiteboard-canvas:${canvasId.value}`, document: ydoc, token: store.getters['auth/token'] || undefined })
  provider.setAwarenessField('user', { id: store.getters['auth/getUserId'], name: store.getters['auth/getName'] || 'Membre', color: userColor() })
  provider.awareness?.on('change', refreshPresence)
  stage.value?.addEventListener('pointermove', publishCursor)
  provider.on('status', ({ status }) => { online.value = status === 'connected' || navigator.onLine })
  ydoc.on('update', (update, origin) => { if (origin !== 'local-ui') applyFromYjs() })
  persistence.once('synced', applyFromYjs)
  applyFromYjs()
})
onBeforeUnmount(() => { clearTimeout(saveTimer.value); stage.value?.removeEventListener('pointermove', publishCursor); provider?.awareness?.off('change', refreshPresence); provider?.destroy(); persistence?.destroy(); ydoc?.destroy(); window.removeEventListener('keydown', keyboard) })
watch(canvasId, () => window.location.reload())
</script>

<style scoped lang="scss">
.whiteboard { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; background: #f8f8fb; color: #25242b; overflow: hidden; }
.whiteboard__header { z-index: 15; height: 58px; flex: 0 0 58px; display: flex; align-items: center; gap: 16px; padding: 0 18px; background: rgba(255,255,255,.94); border-bottom: 1px solid #e9e8ef; backdrop-filter: blur(14px); }
.whiteboard__identity { display: flex; align-items: center; gap: 8px; min-width: 240px; }.whiteboard__icon { font-size: 21px; }.whiteboard__name { border: 0; background: transparent; font-size: 15px; font-weight: 650; outline: 0; width: 230px; }
.whiteboard__status { margin: 0 auto; color: #777481; font-size: 12px; display: flex; align-items: center; gap: 7px; }.whiteboard__status-dot { width: 7px; height: 7px; border-radius: 50%; background: #58a77b; }.whiteboard__status-dot--offline { background: #e4a241; }
.whiteboard__presence{display:flex;margin-left:auto}.whiteboard__avatar{width:27px;height:27px;margin-left:-6px;border:2px solid #fff;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:9px;font-weight:700}
.whiteboard__actions { display: flex; align-items: center; gap: 6px; }.whiteboard__button { height: 34px; min-width: 34px; border: 1px solid #e6e4ec; background: #fff; border-radius: 9px; color: #55515f; cursor: pointer; }.whiteboard__button:hover { background: #f4f2fb; color: #5547d7; }.whiteboard__button:disabled { opacity: .35; }.whiteboard__button--text { padding: 0 12px; display: flex; gap: 6px; align-items: center; }
.whiteboard__menu-wrap { position: relative; }.whiteboard__menu { position: absolute; top: 40px; right: 0; width: 220px; padding: 7px; border-radius: 12px; background: white; box-shadow: 0 14px 38px rgba(37,31,64,.16); border: 1px solid #e9e7f0; }.whiteboard__menu button { display: block; width: 100%; border: 0; background: none; padding: 9px 10px; border-radius: 7px; text-align: left; cursor: pointer; }.whiteboard__menu button:hover { background: #f4f2fb; }
.whiteboard__menu--arrange{left:0;right:auto}
.whiteboard__stage { position: relative; flex: 1; min-height: 0; }.whiteboard__flow { width: 100%; height: 100%; }.whiteboard__flow--draw { pointer-events: none; }.whiteboard__drawing-layer { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 6; }
.whiteboard__toolbar { position: absolute; z-index: 12; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; gap: 3px; padding: 6px; border-radius: 14px; border: 1px solid #e3e1ea; background: rgba(255,255,255,.96); box-shadow: 0 12px 32px rgba(39,32,69,.13); }.whiteboard__toolbar button { border: 0; background: transparent; min-width: 48px; height: 46px; border-radius: 9px; color: #5f5b67; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; }.whiteboard__toolbar button span { font-size: 9px; }.whiteboard__toolbar button:hover,.whiteboard__toolbar button.active { background: #efedff; color: #5547d7; }
.whiteboard__welcome { position: absolute; z-index: 8; left: 50%; top: 46%; transform: translate(-50%,-50%); width: min(520px, 90%); text-align: center; pointer-events: none; }.whiteboard__welcome-icon { font-size: 32px; color: #6d5ce8; }.whiteboard__welcome h2 { margin: 9px 0 5px; font-size: 25px; }.whiteboard__welcome p { color: #777481; margin: 0 0 20px; }.whiteboard__templates { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; pointer-events: auto; }.whiteboard__templates button { border: 1px solid #e4e1ec; background: rgba(255,255,255,.95); border-radius: 10px; padding: 10px 12px; cursor: pointer; }.whiteboard__templates button:hover { border-color: #8171e8; transform: translateY(-1px); }.whiteboard__templates span { margin-right: 6px; }
.whiteboard__remote-cursor{position:absolute;z-index:20;left:0;top:0;pointer-events:none;transition:transform .08s linear}.whiteboard__remote-cursor i{font-size:20px}.whiteboard__remote-cursor span{display:block;margin:1px 0 0 13px;padding:3px 6px;border-radius:4px;color:#fff;font-size:10px;white-space:nowrap}
@media (max-width: 780px) { .whiteboard__header { padding: 0 10px; }.whiteboard__status { display: none; }.whiteboard__identity { min-width: 0; flex: 1; }.whiteboard__name { width: 100%; }.whiteboard__button--text { font-size: 0; padding: 0; }.whiteboard__toolbar { left: 8px; right: 8px; bottom: 8px; transform: none; overflow-x: auto; justify-content: flex-start; border-radius: 16px; }.whiteboard__toolbar button { min-width: 54px; } }
@media print { .whiteboard__header,.whiteboard__toolbar { display:none; }.whiteboard { height: 100vh; } }
</style>
