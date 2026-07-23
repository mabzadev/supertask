<template>
  <node-view-wrapper class="document-callout" :class="`callout-${node.attrs.type}`">
    <div class="document-callout__icon" contenteditable="false" @click="changeIcon">
      {{ node.attrs.icon }}
    </div>
    <div class="document-callout__content">
      <node-view-content />
    </div>
  </node-view-wrapper>
</template>

<script>
import { nodeViewProps, NodeViewWrapper, NodeViewContent } from '@tiptap/vue-3'

export default {
  name: 'Callout',
  components: {
    NodeViewWrapper,
    NodeViewContent,
  },
  props: nodeViewProps,
  methods: {
    changeIcon() {
      // In a full implementation, this opens an emoji picker.
      // For now, cycle through a few emojis.
      const emojis = ['💡', '⚠️', '🔥', '✅', '❌', '📌', '💬']
      const currentIndex = emojis.indexOf(this.node.attrs.icon)
      const nextIndex = (currentIndex + 1) % emojis.length
      this.updateAttributes({
        icon: emojis[nextIndex],
      })
    },
  },
}
</script>

<style scoped>
.document-callout {
  display: flex;
  padding: 16px;
  margin: 1rem 0;
  border-radius: 4px;
  background-color: #f3f4f6;
  border: 1px solid #e5e7eb;
}

.document-callout__icon {
  margin-right: 12px;
  font-size: 1.25rem;
  cursor: pointer;
  user-select: none;
}

.document-callout__content {
  flex-grow: 1;
}

.callout-info {
  background-color: #f3f4f6;
  border-color: #e5e7eb;
}

.callout-warning {
  background-color: #fef9c3;
  border-color: #fef08a;
}

.callout-success {
  background-color: #dcfce7;
  border-color: #bbf7d0;
}

.callout-error {
  background-color: #fee2e2;
  border-color: #fecaca;
}
</style>
