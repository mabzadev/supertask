import { Node, mergeAttributes } from '@tiptap/core'

export const DynamicLookup = Node.create({
  name: 'dynamicLookup',

  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      tableId: { default: null },
      rowId: { default: null },
      fieldId: { default: null },
      fallbackText: { default: 'Variable' },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="dynamic-lookup"]',
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'dynamic-lookup',
        class: 'rich-text-editor__dynamic-lookup',
        style: 'display: inline-flex; align-items: center; background: #f0f4f8; border: 1px solid #d9e2ec; color: #102a43; padding: 0 6px; border-radius: 4px; font-size: 0.9em; font-family: monospace; white-space: nowrap; cursor: pointer;'
      }),
      `🔗 ${HTMLAttributes.fallbackText}`,
    ]
  },

  addCommands() {
    return {
      insertDynamicLookup:
        (options) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: options,
          })
        },
    }
  },
})
