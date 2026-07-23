<template>
  <div class="doc" :class="{ 'doc--focus': focusMode }">
    <header class="doc__topbar">
      <PageBreadcrumbs v-if="pageId && documentId" :page-id="pageId" :document-id="documentId" />
      <div class="doc__presence">
        <span v-for="person in visiblePeople" :key="person.clientId" class="doc__avatar" :style="{ background: person.color }" :title="person.name">{{ initials(person.name) }}</span>
      </div>
      <span class="doc__save-state" :class="{ 'doc__save-state--error': saveError }">
        <i :class="saveError ? 'iconoir-warning-triangle' : saving ? 'iconoir-refresh-double' : 'iconoir-check-circle'"></i>
        {{ saveError ? 'Échec de l’enregistrement' : saving ? 'Enregistrement…' : 'Enregistré' }}
      </span>
      <button class="doc__top-button" title="Commentaires" @click="commentsOpen = !commentsOpen"><i class="iconoir-chat-bubble"></i><span>Commentaires</span></button>
      <div class="doc__menu-wrap">
        <button class="doc__top-button" title="Menu de la page" @click="menuOpen = !menuOpen"><i class="iconoir-more-horiz"></i></button>
        <div v-if="menuOpen" class="doc__page-menu">
          <button @click="focusMode = !focusMode"><i :class="focusMode ? 'iconoir-collapse' : 'iconoir-expand'"></i>{{ focusMode ? 'Quitter le mode focus' : 'Mode focus' }}</button>
          <button @click="openImport"><i class="iconoir-upload"></i>Importer du Markdown</button>
          <button @click="exportMarkdown"><i class="iconoir-download"></i>Exporter en Markdown</button>
          <button @click="printPdf"><i class="iconoir-page"></i>Exporter en PDF</button>
          <button @click="versionsOpen = !versionsOpen"><i class="iconoir-clock"></i>Historique et versions</button>
          <button @click="duplicatePage"><i class="iconoir-copy"></i>Dupliquer la page</button>
          <button class="danger" @click="deletePage"><i class="iconoir-bin"></i>Supprimer la page</button>
        </div>
      </div>
    </header>

    <input ref="markdownInput" hidden type="file" accept=".md,.markdown,text/markdown,text/plain" @change="importMarkdown" />
    <input ref="coverInput" hidden type="file" accept="image/*" @change="uploadCover" />

    <div v-if="loading" class="doc__loading"><div class="loading"></div></div>
    <main v-else-if="page" ref="scrollArea" class="doc__scroll">
      <div v-if="cover" class="doc__cover" :style="{ backgroundImage: `url(${cover})` }">
        <button @click="coverInput?.click()">Changer la couverture</button>
        <button @click="removeCover">Retirer</button>
      </div>
      <article class="doc__paper">
        <div class="doc__page-actions">
          <button v-if="!cover" @click="coverInput?.click()"><i class="iconoir-media-image"></i>Ajouter une couverture</button>
          <button @click="iconPickerOpen = !iconPickerOpen"><i class="iconoir-emoji"></i>{{ icon ? 'Changer l’icône' : 'Ajouter une icône' }}</button>
          <div v-if="iconPickerOpen" class="doc__icon-picker">
            <button v-for="emoji in emojis" :key="emoji" @click="setIcon(emoji)">{{ emoji }}</button>
            <button title="Retirer l’icône" @click="setIcon('')">×</button>
          </div>
        </div>
        <button v-if="icon" class="doc__icon" title="Changer l’icône" @click="iconPickerOpen = !iconPickerOpen">{{ icon }}</button>
        <input v-model="title" class="doc__title" :placeholder="$t('documentsModule.untitled')" :readonly="readOnly" @input="queueSave" />

        <div v-if="readOnly" class="doc__schema-warning"><i class="iconoir-refresh"></i>Cette page utilise une version plus récente de l’éditeur. Actualisez OpenTabl pour la modifier sans perdre de blocs.</div>

        <div class="doc__formatbar" aria-label="Mise en forme">
          <button title="Gras" @click="command('toggleBold')"><strong>B</strong></button>
          <button title="Italique" @click="command('toggleItalic')"><em>I</em></button>
          <button title="Souligné" @click="command('toggleUnderline')"><u>U</u></button>
          <span></span>
          <button title="Titre 1" @click="heading(1)">H1</button>
          <button title="Titre 2" @click="heading(2)">H2</button>
          <button title="Liste à puces" @click="command('toggleBulletList')"><i class="iconoir-list"></i></button>
          <button title="Liste de tâches" @click="command('toggleTaskList')"><i class="iconoir-task-list"></i></button>
          <button title="Citation" @click="command('toggleBlockquote')"><i class="iconoir-quote"></i></button>
          <button title="Insérer une image" @click="imageInput?.click()"><i class="iconoir-media-image"></i></button>
          <input ref="imageInput" hidden type="file" accept="image/*" @change="uploadEditorImage" />
        </div>

        <div class="doc__editor">
          <RichTextEditor
            ref="editor"
            v-model="content"
            :editable="!readOnly"
            :enable-rich-text-formatting="true"
            :disable-history="collaborationEnabled"
            :editor-extensions="customExtensions"
            :scrollable-area-element="scrollArea"
            placeholder="Écrivez quelque chose ou tapez « / » pour les commandes…"
            @update:modelValue="queueSave"
          />
        </div>
        <footer class="doc__stats">{{ wordCount }} mots · {{ readingTime }} min de lecture</footer>
      </article>
    </main>
    <div v-else class="doc__empty"><i class="iconoir-page"></i><h2>Aucune page sélectionnée</h2><p>Choisissez une page dans la barre latérale ou créez-en une nouvelle.</p></div>

    <CollaborationPanel v-if="commentsOpen" kind="document-page" :content-id="pageId" :anchor="commentAnchor" @close="commentsOpen = false" />
    <VersionPanel v-if="versionsOpen" kind="document-page" :content-id="pageId" @close="versionsOpen = false" @restored="reloadPage" />
  </div>
</template>

<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useStore } from 'vuex'
import { useNuxtApp, useRuntimeConfig } from '#imports'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { Collaboration } from '@tiptap/extension-collaboration'
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret'
import RichTextEditor from '@baserow/modules/core/components/editor/RichTextEditor.vue'
import PageBreadcrumbs from '@baserow/modules/documents/components/PageBreadcrumbs.vue'
import CollaborationPanel from '@baserow/modules/core/components/collaboration/CollaborationPanel.vue'
import VersionPanel from '@baserow/modules/core/components/collaboration/VersionPanel.vue'
import UserFileService from '@baserow/modules/core/services/userFile'
import { SlashCommand } from '@baserow/modules/documents/editor/slashCommand'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { Image } from '@tiptap/extension-image'
import { CharacterCount } from '@tiptap/extension-character-count'
import { HorizontalRule } from '@tiptap/extension-horizontal-rule'
import { Youtube } from '@tiptap/extension-youtube'
import Callout from '@baserow/modules/documents/editor/callout'
import GlobalDragHandle from 'tiptap-extension-global-drag-handle'
import FileHandler from '@tiptap/extension-file-handler'

const EDITOR_SCHEMA_VERSION = 1
const route = useRoute()
const router = useRouter()
const store = useStore()
const nuxtApp = useNuxtApp()
const config = useRuntimeConfig()
const documentId = computed(() => Number(route.params.documentId))
const pageId = computed(() => Number(route.params.pageId))
const page = computed(() => store.getters['documentPage/getPage'](pageId.value))
const loading = ref(false)
const title = ref(page.value?.title || '')
const content = ref(normalizeContent(page.value?.content))
const icon = ref(page.value?.icon || '')
const cover = ref(page.value?.cover || '')
const editor = ref(null)
const scrollArea = ref(null)
const imageInput = ref(null)
const coverInput = ref(null)
const markdownInput = ref(null)
const saving = ref(false)
const saveError = ref(false)
const savePending = ref(false)
const menuOpen = ref(false)
const commentsOpen = ref(false)
const versionsOpen = ref(false)
const iconPickerOpen = ref(false)
const focusMode = ref(false)
const collaborationEnabled = ref(import.meta.client)
const people = ref([])
const emojis = ['📄','📝','💡','✨','📌','✅','🎯','🚀','📚','🧠','❤️','🔖','🗂️','📅','🔍','⚙️','🌱','🎨','💬','⚡']
const collabDoc = import.meta.client ? new Y.Doc() : null
const collaborationUrl = import.meta.client
  ? (config.public.publicBackendUrl || window.location.origin).replace(/^http/, 'ws') + `/ws/collaboration/document-page/${pageId.value}/?editor_schema_version=${EDITOR_SCHEMA_VERSION}&jwt_token=${encodeURIComponent(store.getters['auth/token'] || '')}`
  : ''
let provider = collabDoc ? new HocuspocusProvider({ url: collaborationUrl, name: `document-page:${pageId.value}`, document: collabDoc, token: store.getters['auth/token'] || undefined }) : null
let persistence

function normalizeContent(value) { if (!value || (typeof value === 'object' && !Object.keys(value).length)) return { type: 'doc', content: [{ type: 'paragraph' }] }; return value }
const readOnly = computed(() => Number(page.value?.editor_schema_version || 1) > EDITOR_SCHEMA_VERSION)
const visiblePeople = computed(() => people.value.slice(0, 5))
const wordCount = computed(() => editor.value?.editor?.storage?.characterCount?.words?.() || 0)
const readingTime = computed(() => Math.max(1, Math.ceil(wordCount.value / 200)))
const commentAnchor = computed(() => {
  const selection = editor.value?.editor?.state?.selection
  return selection ? { type: 'text', from: selection.from, to: selection.to, quote: editor.value.editor.state.doc.textBetween(selection.from, selection.to, ' ') } : { type: 'page' }
})

const customExtensions = computed(() => {
  const extensions = [
    SlashCommand, Table.configure({ resizable: true }), TableRow, TableHeader, TableCell,
    Image.configure({ inline: false, allowBase64: false }), CharacterCount, HorizontalRule,
    Youtube.configure({ controls: true, nocookie: true }), Callout,
    GlobalDragHandle.configure({ dragHandleWidth: 24, scrollTreshold: 100 }),
    FileHandler.configure({
      allowedMimeTypes: ['image/png','image/jpeg','image/gif','image/webp'],
      onDrop: (instance, files, pos) => uploadFilesIntoEditor(instance, files, pos),
      onPaste: (instance, files) => uploadFilesIntoEditor(instance, files),
    }),
  ]
  if (collabDoc) {
    extensions.push(Collaboration.configure({ document: collabDoc, field: 'default' }))
    extensions.push(CollaborationCaret.configure({ provider, user: { name: store.getters['auth/getName'] || 'Membre', color: userColor() } }))
  }
  return markRaw(extensions)
})

function userColor() { const colors = ['#6658d9','#d0587e','#238b70','#c0782b','#3976c6']; return colors[(store.getters['auth/getUserId'] || 0) % colors.length] }
function initials(name) { return String(name || '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() }
function setIcon(value) { icon.value = value; iconPickerOpen.value = false; queueSave() }
function openImport() { menuOpen.value = false; markdownInput.value?.click() }
function command(name) { editor.value?.editor?.chain().focus()[name]().run() }
function heading(level) { editor.value?.editor?.chain().focus().toggleHeading({ level }).run() }

function mirrorMaterialized() {
  if (!collabDoc) return
  collabDoc.getMap('opentabl').set('materialized', { title: title.value, content: content.value, icon: icon.value, cover: cover.value, settings: {}, editor_schema_version: EDITOR_SCHEMA_VERSION })
}
function queueSave() {
  mirrorMaterialized()
  savePending.value = true
  if (!saving.value) window.setTimeout(flushSaves, 450)
}
async function flushSaves() {
  if (saving.value || !savePending.value || readOnly.value) return
  saving.value = true; saveError.value = false
  while (savePending.value) {
    savePending.value = false
    const values = { title: title.value, content: content.value, icon: icon.value, cover: cover.value, settings: {}, editor_schema_version: EDITOR_SCHEMA_VERSION, collaboration_initialized: true }
    try { await store.dispatch('documentPage/update', { pageId: pageId.value, values }) }
    catch { saveError.value = true; savePending.value = true; break }
  }
  saving.value = false
}

async function uploadFile(file) { const { data } = await UserFileService(nuxtApp.$client).uploadFile(file); return data.user_file || data }
async function uploadFilesIntoEditor(instance, files, pos = null) {
  for (const file of files) {
    const uploaded = await uploadFile(file); const node = { type: 'image', attrs: { src: uploaded.url, alt: uploaded.original_name || file.name } }
    pos === null ? instance.chain().focus().insertContent(node).run() : instance.chain().focus().insertContentAt(pos, node).run()
  }
}
async function uploadEditorImage(event) { const file = event.target.files?.[0]; if (file) await uploadFilesIntoEditor(editor.value.editor, [file]); event.target.value = '' }
async function uploadCover(event) { const file = event.target.files?.[0]; if (!file) return; const uploaded = await uploadFile(file); cover.value = uploaded.url; queueSave(); event.target.value = '' }
function removeCover() { cover.value = ''; queueSave() }
async function importMarkdown(event) { const file = event.target.files?.[0]; if (!file) return; const text = await file.text(); editor.value?.editor?.commands.setContent(text); title.value ||= file.name.replace(/\.(md|markdown)$/i, ''); queueSave(); event.target.value = '' }
function exportMarkdown() { menuOpen.value = false; const text = editor.value?.serializeToMarkdown?.() || editor.value?.editor?.storage?.markdown?.getMarkdown?.() || ''; const blob = new Blob([text], { type: 'text/markdown' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${title.value || 'sans-titre'}.md`; link.click(); URL.revokeObjectURL(url) }
function printPdf() { menuOpen.value = false; window.print() }
async function duplicatePage() { const copy = await store.dispatch('documentPage/create', { documentId: documentId.value, values: { title: `${title.value || 'Sans titre'} copie`, content: content.value, icon: icon.value, cover: cover.value, parent_id: page.value?.parent_id || null } }); router.push({ name: 'document-page', params: { documentId: documentId.value, pageId: copy.id } }) }
async function deletePage() { if (!window.confirm('Supprimer cette page ?')) return; await store.dispatch('documentPage/delete', pageId.value); const remaining = store.getters['documentPage/getPages'].filter((item) => item.document_id === documentId.value); router.push(remaining[0] ? { name: 'document-page', params: { documentId: documentId.value, pageId: remaining[0].id } } : { name: 'dashboard' }) }
async function reloadPage() { await store.dispatch('documentPage/fetch', pageId.value); hydrateFromPage() }
function hydrateFromPage() { title.value = page.value?.title || ''; content.value = normalizeContent(page.value?.content); icon.value = page.value?.icon || ''; cover.value = page.value?.cover || '' }

function connectCollaboration() {
  if (!collabDoc) return
  persistence = new IndexeddbPersistence(`opentabl:document:${pageId.value}`, collabDoc)
  provider.setAwarenessField('user', { id: store.getters['auth/getUserId'], name: store.getters['auth/getName'] || 'Membre', color: userColor() })
  const refreshPeople = () => { people.value = [...provider.awareness.getStates()].map(([clientId, state]) => ({ clientId, ...(state.user || {}) })).filter((item) => item.name) }
  provider.awareness.on('change', refreshPeople)
  persistence.once('synced', () => {
    const fragment = collabDoc.getXmlFragment('default')
    if (fragment.length === 0 && editor.value?.editor) editor.value.editor.commands.setContent(content.value)
    mirrorMaterialized()
  })
}

onMounted(() => { connectCollaboration(); nextTick(() => editor.value?.editor?.commands.focus('end')) })
onBeforeUnmount(async () => { await flushSaves(); provider?.destroy(); persistence?.destroy(); collabDoc?.destroy() })
watch(pageId, async () => { await flushSaves(); hydrateFromPage(); window.location.reload() })
</script>

<style scoped lang="scss">
.doc { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; background: #fbfafc; color: #27262d; }.doc--focus { position: fixed; inset: 0; z-index: 1000; }
.doc__topbar { position: relative; z-index: 20; height: 52px; flex: 0 0 52px; display: flex; align-items: center; gap: 8px; padding: 0 14px; border-bottom: 1px solid #eceaf0; background: rgba(255,255,255,.92); backdrop-filter: blur(14px); }.doc__presence { display: flex; margin-left: auto; }.doc__avatar { width: 26px; height: 26px; margin-left: -6px; border: 2px solid white; border-radius: 50%; color: white; display: grid; place-items: center; font-size: 9px; font-weight: 700; }.doc__save-state { color: #797580; font-size: 12px; display:flex; align-items:center; gap:5px; }.doc__save-state--error { color:#b74545; }.doc__top-button { height: 32px; padding: 0 10px; border: 1px solid #e7e5eb; border-radius: 8px; background: #fff; color: #5d5964; cursor: pointer; display:flex; align-items:center; gap:6px; }.doc__top-button:hover { background:#f4f2fb;color:#5547d7; }
.doc__menu-wrap { position:relative; }.doc__page-menu { position:absolute; top:38px; right:0; width:240px; padding:7px; border:1px solid #e6e3ec; border-radius:12px; background:#fff; box-shadow:0 14px 38px rgba(37,31,64,.16); }.doc__page-menu button { width:100%; padding:9px 10px; border:0; border-radius:7px; background:none; display:flex; gap:9px; text-align:left; cursor:pointer; }.doc__page-menu button:hover { background:#f4f2fb; }.doc__page-menu button.danger { color:#b53e47; }
.doc__scroll { flex:1; min-height:0; overflow-y:auto; }.doc__cover { height:230px; background-size:cover; background-position:center; display:flex; align-items:flex-end; justify-content:flex-end; gap:6px; padding:12px 18px; }.doc__cover button { border:1px solid rgba(255,255,255,.7); border-radius:7px; background:rgba(25,22,31,.58); color:#fff; padding:7px 10px; cursor:pointer; }
.doc__paper { position:relative; width:min(860px, calc(100% - 48px)); min-height:calc(100% - 80px); margin:0 auto; padding:52px 80px 90px; box-sizing:border-box; }.doc__cover + .doc__paper { margin-top:-24px; border-radius:16px 16px 0 0; background:#fff; }.doc__page-actions { position:relative; height:28px; display:flex; gap:12px; opacity:0; transition:opacity .15s; }.doc__paper:hover .doc__page-actions { opacity:1; }.doc__page-actions>button { border:0;background:none;color:#8b8791;font-size:12px;cursor:pointer; }.doc__page-actions>button:hover{color:#5649cc;}.doc__icon-picker { position:absolute; z-index:10; top:30px; left:145px; width:230px; padding:8px; display:grid; grid-template-columns:repeat(7,1fr); gap:3px; background:#fff; border:1px solid #e5e2eb; border-radius:12px; box-shadow:0 12px 30px rgba(40,32,65,.15); }.doc__icon-picker button{border:0;background:none;font-size:20px;padding:5px;border-radius:6px;cursor:pointer}.doc__icon-picker button:hover{background:#f0edff}.doc__icon { margin:8px 0 10px; padding:0; border:0; background:none; font-size:56px; cursor:pointer; }.doc__title { width:100%; border:0; outline:0; background:transparent; color:#25242a; font:700 clamp(34px,5vw,46px)/1.15 Inter,sans-serif; letter-spacing:-.035em; }.doc__title::placeholder { color:#c5c2ca; }
.doc__schema-warning { margin:22px 0; padding:12px 14px; border-radius:9px; background:#fff5d9;color:#7c5e16;font-size:13px;}.doc__formatbar { position:sticky; z-index:8; top:10px; margin:28px 0 8px; padding:5px; border:1px solid #e9e6ee; border-radius:10px; background:rgba(255,255,255,.95); box-shadow:0 5px 18px rgba(43,35,68,.06); display:flex; width:max-content; max-width:100%; overflow-x:auto; }.doc__formatbar button { min-width:32px;height:30px;border:0;border-radius:6px;background:none;color:#5e5965;cursor:pointer}.doc__formatbar button:hover{background:#efedff;color:#5547d7}.doc__formatbar>span{width:1px;background:#e7e4ec;margin:4px;}
.doc__editor { min-height:430px; }.doc__stats { margin-top:48px;color:#aaa5af;font-size:11px; }.doc__empty,.doc__loading { flex:1;display:grid;place-items:center;text-align:center;color:#8e8995}.doc__empty i{font-size:42px}.doc__empty h2{margin:10px 0 4px;color:#4a4650}.doc__empty p{margin:0}.doc :deep(.rich-text-editor__content .ProseMirror){min-height:420px;padding:12px 0;font-size:16px;line-height:1.72;color:#343139;outline:none}.doc :deep(.ProseMirror h1){font-size:30px;margin:1.4em 0 .5em}.doc :deep(.ProseMirror h2){font-size:24px;margin:1.25em 0 .45em}.doc :deep(.ProseMirror p){margin:.4em 0}.doc :deep(.drag-handle){border-radius:6px;background-color:transparent;color:#aaa5b1}.doc :deep(.drag-handle:hover){background:#efedff}
@media(max-width:760px){.doc__paper{width:100%;padding:35px 22px 100px}.doc__cover{height:170px}.doc__formatbar{width:100%;box-sizing:border-box}.doc__top-button span{display:none}.doc__save-state{display:none}}
@media print{.doc__topbar,.doc__page-actions,.doc__formatbar{display:none}.doc__scroll{overflow:visible}.doc__paper{width:100%;padding:20mm}.doc{background:#fff;height:auto}}
</style>
