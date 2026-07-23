<template>
  <div class="board-node" :class="[`board-node--${kind}`, `board-node--${data.shape || ''}`, `board-node--${data.color || 'neutral'}`]" :style="nodeStyle">
    <Handle type="target" :position="Position.Left" class="board-node__handle" />
    <img v-if="kind === 'image' && data.src" :src="data.src" :alt="data.text || ''" class="board-node__image" draggable="false" />
    <div v-if="kind === 'frame'" class="board-node__frame-title">
      <input :value="data.text" @change="changeText" @pointerdown.stop />
    </div>
    <textarea v-else-if="kind !== 'image'" :value="data.text" rows="2" spellcheck="true" @change="changeText" @pointerdown.stop></textarea>
    <div v-else class="board-node__caption">{{ data.text }}</div>
    <Handle type="source" :position="Position.Right" class="board-node__handle" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
const props = defineProps({ id: { type: String, required: true }, data: { type: Object, required: true }, kind: { type: String, required: true } })
const emit = defineEmits(['change'])
const nodeStyle = computed(() => ({ width: `${props.data.width || (props.kind === 'text' ? 220 : 180)}px`, minHeight: `${props.data.height || (props.kind === 'text' ? 54 : 100)}px` }))
function changeText(event) { emit('change', { id: props.id, text: event.target.value }) }
</script>

<style scoped lang="scss">
.board-node { position: relative; box-sizing: border-box; border: 1px solid #dcd9e7; border-radius: 12px; background: #fff; box-shadow: 0 3px 12px rgba(37,31,64,.07); display: flex; align-items: center; justify-content: center; overflow: hidden; }
.board-node textarea,.board-node input { width: 100%; min-height: 52px; padding: 14px; border: 0; outline: 0; resize: none; background: transparent; text-align: center; color: #292731; font: 500 15px/1.35 Inter, sans-serif; box-sizing: border-box; }
.board-node--sticky { border-radius: 3px; background: #fff2a8; border-color: #eadc86; box-shadow: 2px 6px 14px rgba(67,58,26,.11); }.board-node--sticky textarea { text-align: left; min-height: 100px; }
.board-node--text { border-color: transparent; background: transparent; box-shadow: none; }.board-node--text textarea { font-size: 18px; }
.board-node--shape { border: 2px solid #8b80dd; background: #f3f0ff; }.board-node--ellipse { border-radius: 999px; }.board-node--diamond { transform: rotate(45deg); border-radius: 5px; }.board-node--diamond textarea { transform: rotate(-45deg); }
.board-node--frame { display: block; justify-content: flex-start; border: 2px solid #bdb8d1; background: rgba(255,255,255,.28); border-radius: 16px; overflow: visible; }.board-node__frame-title { position: absolute; top: -37px; left: -2px; }.board-node__frame-title input { text-align: left; font-weight: 700; padding: 6px 2px; min-height: 30px; }
.board-node__image { width: 100%; height: 100%; object-fit: cover; }.board-node__caption { position: absolute; bottom: 0; inset-inline: 0; background: rgba(20,18,28,.65); color: #fff; padding: 5px 8px; font-size: 11px; }
.board-node__handle { width: 9px; height: 9px; border: 2px solid #fff; background: #6658d9; opacity: 0; transition: opacity .12s; }.board-node:hover .board-node__handle { opacity: 1; }
</style>
