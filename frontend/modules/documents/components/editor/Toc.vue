<template>
  <node-view-wrapper class="document-toc">
    <div class="document-toc__header" contenteditable="false">Table des matières</div>
    <ul v-if="headings.length" class="document-toc__list" contenteditable="false">
      <li v-for="(heading, index) in headings" :key="index" :class="`document-toc__item--level-${heading.level}`">
        <a @click.prevent="scrollTo(heading.pos)">{{ heading.text }}</a>
      </li>
    </ul>
    <div v-else class="document-toc__empty" contenteditable="false">Aucun titre à afficher</div>
  </node-view-wrapper>
</template>

<script>
import { nodeViewProps, NodeViewWrapper } from '@tiptap/vue-3'

export default {
  name: 'Toc',
  components: {
    NodeViewWrapper,
  },
  props: nodeViewProps,
  data() {
    return {
      headings: [],
    }
  },
  mounted() {
    this.updateHeadings()
    this.editor.on('transaction', this.handleTransaction)
  },
  beforeUnmount() {
    this.editor.off('transaction', this.handleTransaction)
  },
  methods: {
    handleTransaction({ transaction }) {
      if (transaction.docChanged) {
        this.updateHeadings()
      }
    },
    updateHeadings() {
      const headings = []
      this.editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          headings.push({
            level: node.attrs.level,
            text: node.textContent,
            pos,
          })
        }
      })
      this.headings = headings
    },
    scrollTo(pos) {
      this.editor.commands.setTextSelection(pos)
      this.editor.commands.scrollIntoView()
    }
  },
}
</script>

<style scoped>
.document-toc {
  background: #fdfdfd;
  border: 1px solid #eaeaeb;
  padding: 16px;
  border-radius: 6px;
  margin: 16px 0;
  user-select: none;
}
.document-toc__header {
  font-weight: 600;
  margin-bottom: 8px;
  color: #555;
  font-size: 0.8em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.document-toc__list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.document-toc__list li {
  margin: 6px 0;
}
.document-toc__list a {
  color: #2eaadc;
  text-decoration: none;
  cursor: pointer;
}
.document-toc__list a:hover {
  text-decoration: underline;
}
.document-toc__item--level-1 { margin-left: 0; font-weight: 500; }
.document-toc__item--level-2 { margin-left: 16px; }
.document-toc__item--level-3 { margin-left: 32px; font-size: 0.9em; opacity: 0.8; }
.document-toc__empty {
  color: #999;
  font-style: italic;
  font-size: 0.9em;
}
</style>
