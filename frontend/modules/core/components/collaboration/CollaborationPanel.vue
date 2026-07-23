<template>
  <aside class="collaboration-panel">
    <header>
      <div><strong>Commentaires</strong><span>{{ activeComments.length }}</span></div>
      <button title="Fermer" @click="$emit('close')"><i class="iconoir-xmark"></i></button>
    </header>
    <div class="collaboration-panel__composer">
      <textarea v-model="draft" rows="3" placeholder="Écrire un commentaire… Mentionnez avec @adresse-email." @keydown.meta.enter="submit" @keydown.ctrl.enter="submit"></textarea>
      <button :disabled="!draft.trim() || sending" @click="submit">Commenter</button>
    </div>
    <div class="collaboration-panel__list">
      <article v-for="comment in activeComments" :key="comment.id" :class="{ resolved: comment.resolved }">
        <div class="collaboration-panel__meta"><span class="collaboration-panel__avatar">{{ initials(comment.user.name) }}</span><strong>{{ comment.user.name }}</strong><time>{{ formatDate(comment.created_on) }}</time></div>
        <p>{{ textFromMessage(comment.message) }}</p>
        <footer>
          <button @click="replyTo = comment.id">Répondre</button>
          <button @click="toggleResolved(comment)">{{ comment.resolved ? 'Rouvrir' : 'Résoudre' }}</button>
        </footer>
        <div v-if="replyTo === comment.id" class="collaboration-panel__reply">
          <textarea v-model="reply" rows="2" placeholder="Votre réponse…"></textarea>
          <button @click="submitReply(comment.id)">Envoyer</button>
        </div>
        <div v-for="child in replies(comment.id)" :key="child.id" class="collaboration-panel__child">
          <strong>{{ child.user.name }}</strong><p>{{ textFromMessage(child.message) }}</p>
        </div>
      </article>
      <div v-if="!activeComments.length" class="collaboration-panel__empty"><i class="iconoir-chat-bubble-empty"></i><p>Aucun commentaire pour le moment.</p></div>
    </div>
  </aside>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useNuxtApp } from '#imports'
const props = defineProps({ kind: { type: String, required: true }, contentId: { type: Number, required: true }, anchor: { type: Object, default: () => ({}) } })
defineEmits(['close'])
const { $client } = useNuxtApp()
const comments = ref([])
const draft = ref('')
const reply = ref('')
const replyTo = ref(null)
const sending = ref(false)
const roots = computed(() => comments.value.filter((comment) => !comment.parent_id))
const activeComments = computed(() => [...roots.value.filter((comment) => !comment.resolved), ...roots.value.filter((comment) => comment.resolved)])
function message(text) { return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }
function textFromMessage(value) { const chunks = []; const visit = (node) => { if (!node) return; if (typeof node.text === 'string') chunks.push(node.text); if (Array.isArray(node.content)) node.content.forEach(visit) }; visit(value); return chunks.join(' ') }
function replies(id) { return comments.value.filter((comment) => comment.parent_id === id) }
function initials(name) { return String(name || '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() }
function formatDate(value) { return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) }
async function load() { const { data } = await $client.get(`/collaboration/${props.kind}/${props.contentId}/comments/`); comments.value = data }
async function submit() { if (!draft.value.trim()) return; sending.value = true; try { const { data } = await $client.post(`/collaboration/${props.kind}/${props.contentId}/comments/`, { message: message(draft.value.trim()), anchor: props.anchor }); comments.value.push(data); draft.value = '' } finally { sending.value = false } }
async function submitReply(parentId) { if (!reply.value.trim()) return; const { data } = await $client.post(`/collaboration/${props.kind}/${props.contentId}/comments/`, { message: message(reply.value.trim()), anchor: props.anchor, parent_id: parentId }); comments.value.push(data); reply.value = ''; replyTo.value = null }
async function toggleResolved(comment) { const { data } = await $client.patch(`/collaboration/${props.kind}/${props.contentId}/comments/${comment.id}/`, { resolved: !comment.resolved }); Object.assign(comment, data) }
onMounted(load)
</script>

<style scoped lang="scss">
.collaboration-panel { position: absolute; z-index: 30; top: 58px; right: 0; bottom: 0; width: 360px; background: #fff; border-left: 1px solid #e8e6ee; box-shadow: -12px 0 34px rgba(38,31,64,.08); display: flex; flex-direction: column; }.collaboration-panel header { height: 54px; padding: 0 16px; border-bottom: 1px solid #eeecf2; display: flex; align-items: center; justify-content: space-between; }.collaboration-panel header div { display: flex; align-items: center; gap: 8px; }.collaboration-panel header span { background: #efedff; color: #5b4dd1; padding: 2px 7px; border-radius: 999px; font-size: 11px; }.collaboration-panel button { border: 0; background: none; cursor: pointer; color: #5c5865; }
.collaboration-panel__composer { padding: 14px; border-bottom: 1px solid #eeecf2; }.collaboration-panel textarea { width: 100%; border: 1px solid #dedbe8; border-radius: 9px; padding: 10px; resize: none; outline: none; font: inherit; box-sizing: border-box; }.collaboration-panel textarea:focus { border-color: #7768e2; box-shadow: 0 0 0 3px #efedff; }.collaboration-panel__composer button,.collaboration-panel__reply button { float: right; margin-top: 8px; padding: 7px 11px; border-radius: 7px; background: #6253d8; color: #fff; }.collaboration-panel__composer button:disabled { opacity: .4; }
.collaboration-panel__list { overflow-y: auto; padding: 5px 14px 20px; }.collaboration-panel article { padding: 14px 0; border-bottom: 1px solid #efedf3; }.collaboration-panel article.resolved { opacity: .55; }.collaboration-panel__meta { display: flex; align-items: center; gap: 7px; font-size: 12px; }.collaboration-panel__meta time { color: #918d99; margin-left: auto; }.collaboration-panel__avatar { width: 25px; height: 25px; display: grid; place-items: center; border-radius: 50%; background: #e8e5ff; color: #5748ce; font-size: 9px; }.collaboration-panel article p { margin: 9px 0; line-height: 1.45; white-space: pre-wrap; }.collaboration-panel article footer { display: flex; gap: 10px; }.collaboration-panel article footer button { color: #6253d8; font-size: 12px; padding: 0; }.collaboration-panel__reply { margin-top: 10px; overflow: hidden; }.collaboration-panel__child { margin: 12px 0 0 31px; padding-left: 12px; border-left: 2px solid #e4e1ef; font-size: 12px; }.collaboration-panel__child p { margin: 4px 0; }.collaboration-panel__empty { padding: 50px 20px; text-align: center; color: #96919e; }.collaboration-panel__empty i { font-size: 28px; }
@media (max-width: 700px) { .collaboration-panel { top: auto; left: 0; width: 100%; height: 70%; border-left: 0; border-top: 1px solid #e8e6ee; border-radius: 18px 18px 0 0; } }
</style>
