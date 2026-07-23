<template>
  <node-view-wrapper class="rich-text-editor__audio-wrapper">
    <div class="rich-text-editor__audio-container" :class="{ 'is-selected': selected }">
      <audio controls :src="node.attrs.src" class="rich-text-editor__audio">
        Your browser does not support the audio element.
      </audio>
    </div>
  </node-view-wrapper>
</template>

<script>
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

export default {
  name: 'AudioNodeView',
  components: {
    NodeViewWrapper,
  },
  props: nodeViewProps,
}
</script>

<style scoped>
.rich-text-editor__audio-wrapper {
  margin: 1.5rem 0;
  display: flex;
  justify-content: center;
}
.rich-text-editor__audio-container {
  padding: 8px;
  border-radius: 8px;
  background-color: #f3f4f6;
  border: 2px solid transparent;
  transition: border-color 0.2s;
  width: 100%;
}
.rich-text-editor__audio-container.is-selected {
  border-color: #8bb2f9;
}
.rich-text-editor__audio {
  width: 100%;
  display: block;
}
</style>
