import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import CalloutComponent from '@supertask/modules/documents/components/editor/Callout.vue'

export default Node.create({
  name: 'callout',

  group: 'block',

  content: 'block+',

  addAttributes() {
    return {
      type: {
        default: 'info', // info, warning, success, error
      },
      icon: {
        default: '💡',
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="callout"]',
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }), 0]
  },

  addNodeView() {
    return VueNodeViewRenderer(CalloutComponent)
  },

  addCommands() {
    return {
      setCallout:
        (options) =>
        ({ commands }) => {
          return commands.setNode(this.name, options)
        },
      toggleCallout:
        (options) =>
        ({ commands }) => {
          return commands.toggleNode(this.name, 'paragraph', options)
        },
    }
  },
})
