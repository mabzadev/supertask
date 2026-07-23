import { Mention as TiptapMention } from '@tiptap/extension-mention'
import { PluginKey } from '@tiptap/pm/state'

export const PageMention = TiptapMention.extend({
  name: 'pageMention',
  addOptions() {
    return {
      ...this.parent?.(),
      HTMLAttributes: {
        class: 'rich-text-editor__page-mention',
      },
      suggestion: {
        char: '+',
        pluginKey: new PluginKey('pageMentionPlugin'),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: 'pageMention',
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
    }
  },
  parseHTML() {
    return [
      {
        tag: 'a[data-type="pageMention"]',
      },
    ]
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'a',
      {
        ...HTMLAttributes,
        'data-type': 'pageMention',
        href: '#', // The router will handle clicks natively
        style: 'color: #2eaadc; padding: 2px 4px; background: rgba(46, 170, 220, 0.1); border-radius: 4px; text-decoration: none;'
      },
      `📄 ${node.attrs.label}`,
    ]
  },
})
