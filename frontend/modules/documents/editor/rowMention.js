import { Mention as TiptapMention } from '@tiptap/extension-mention'
import { PluginKey } from '@tiptap/pm/state'

export const RowMention = TiptapMention.extend({
  name: 'rowMention',
  addOptions() {
    return {
      ...this.parent?.(),
      HTMLAttributes: {
        class: 'rich-text-editor__row-mention',
      },
      suggestion: {
        char: '@',
        pluginKey: new PluginKey('rowMentionPlugin'),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: 'rowMention',
                attrs: props,
              },
              {
                type: 'text',
                text: ' ',
              },
            ])
            .run()
        },
      },
    }
  },
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-id'),
        renderHTML: (attributes) => {
          if (!attributes.id) {
            return {}
          }
          return { 'data-id': attributes.id }
        },
      },
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-label'),
        renderHTML: (attributes) => {
          if (!attributes.label) {
            return {}
          }
          return { 'data-label': attributes.label }
        },
      },
      tableId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-table-id'),
        renderHTML: (attributes) => {
          if (!attributes.tableId) return {}
          return { 'data-table-id': attributes.tableId }
        },
      },
    }
  },
  parseHTML() {
    return [
      {
        tag: 'a[data-type="rowMention"]',
      },
    ]
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'a',
      {
        ...HTMLAttributes,
        'data-type': 'rowMention',
        href: '#', 
        style: 'color: #f7641c; padding: 2px 4px; background: rgba(247, 100, 28, 0.1); border-radius: 4px; text-decoration: none;'
      },
      `📇 ${node.attrs.label}`,
    ]
  },
})
