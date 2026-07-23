<template>
  <aside class="version-panel">
    <header><div><strong>Historique</strong><span>30 jours</span></div><button title="Fermer" @click="$emit('close')"><i class="iconoir-xmark"></i></button></header>
    <div class="version-panel__create">
      <input v-model="name" placeholder="Nom de la version" @keydown.enter="createVersion" />
      <button :disabled="!name.trim()" @click="createVersion">Enregistrer</button>
    </div>
    <div class="version-panel__list">
      <article v-for="version in versions" :key="version.id">
        <div class="version-panel__dot" :class="{ automatic: version.automatic }"><i :class="version.automatic ? 'iconoir-refresh-double' : 'iconoir-bookmark'" /></div>
        <div><strong>{{ version.name || 'Sauvegarde automatique' }}</strong><p>{{ formatDate(version.created_on) }}<template v-if="version.created_by"> · {{ version.created_by.name }}</template></p></div>
        <button title="Restaurer" @click="restore(version)"><i class="iconoir-undo"></i></button>
      </article>
      <div v-if="loading" class="version-panel__empty"><div class="loading"></div></div>
      <div v-else-if="!versions.length" class="version-panel__empty"><i class="iconoir-clock"></i><p>L’historique apparaîtra après vos premières modifications.</p></div>
    </div>
  </aside>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useNuxtApp } from '#imports'
const props = defineProps({ kind: { type: String, required: true }, contentId: { type: Number, required: true } })
const emit = defineEmits(['close', 'restored'])
const { $client } = useNuxtApp()
const versions = ref([])
const name = ref('')
const loading = ref(true)
function formatDate(value) { return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }
async function load() { loading.value = true; try { const { data } = await $client.get(`/collaboration/${props.kind}/${props.contentId}/versions/`); versions.value = data } finally { loading.value = false } }
async function createVersion() { if (!name.value.trim()) return; await $client.post(`/collaboration/${props.kind}/${props.contentId}/versions/`, { name: name.value.trim() }); name.value = ''; await load() }
async function restore(version) { if (!window.confirm(`Restaurer « ${version.name || 'Sauvegarde automatique'} » ? Une copie de l’état actuel sera conservée.`)) return; await $client.post(`/collaboration/${props.kind}/${props.contentId}/versions/${version.id}/restore/`); emit('restored'); await load() }
onMounted(load)
</script>

<style scoped lang="scss">
.version-panel{position:absolute;z-index:31;top:52px;right:0;bottom:0;width:360px;background:#fff;border-left:1px solid #e8e6ee;box-shadow:-12px 0 34px rgba(38,31,64,.08);display:flex;flex-direction:column}.version-panel header{height:54px;padding:0 16px;border-bottom:1px solid #eeecf2;display:flex;align-items:center;justify-content:space-between}.version-panel header div{display:flex;gap:8px;align-items:center}.version-panel header span{font-size:10px;color:#7669d8;background:#efedff;padding:3px 7px;border-radius:99px}.version-panel button{border:0;background:none;cursor:pointer}.version-panel__create{padding:14px;display:flex;gap:7px;border-bottom:1px solid #eeecf2}.version-panel__create input{flex:1;border:1px solid #dedbe8;border-radius:8px;padding:8px;outline:0}.version-panel__create input:focus{border-color:#7163dd}.version-panel__create button{background:#6253d8;color:#fff;border-radius:8px;padding:0 11px}.version-panel__create button:disabled{opacity:.4}.version-panel__list{overflow:auto;padding:8px 14px}.version-panel article{display:flex;align-items:center;gap:10px;padding:12px 2px;border-bottom:1px solid #f0eef3}.version-panel article>div:nth-child(2){flex:1}.version-panel article strong{font-size:13px}.version-panel article p{margin:3px 0 0;color:#928e99;font-size:10px}.version-panel__dot{width:30px;height:30px;border-radius:9px;background:#e9e6ff;color:#594bcf;display:grid;place-items:center}.version-panel__dot.automatic{background:#f0eff3;color:#8b8792}.version-panel__empty{padding:50px 20px;text-align:center;color:#96919e}.version-panel__empty>i{font-size:28px}@media(max-width:700px){.version-panel{top:auto;left:0;width:100%;height:70%;border-radius:18px 18px 0 0;border-top:1px solid #e8e6ee}}
</style>
