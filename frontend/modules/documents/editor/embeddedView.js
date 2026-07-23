import { Node, mergeAttributes } from '@tiptap/core'

export const EmbeddedView = Node.create({
  name: 'embeddedView',

  group: 'block',

  atom: true,

  addAttributes() {
    return {
      src: {
        default: null,
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'iframe[data-type="embedded-view"]',
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    if (!HTMLAttributes.src) {
      return ['div', { class: 'embedded-view-placeholder' }, 'Embedded View']
    }
    
    return [
      'div',
      { class: 'embedded-view-wrapper', style: 'position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; max-width: 100%; border: 1px solid #e0e0e0; border-radius: 8px; margin: 16px 0;' },
      ['iframe', mergeAttributes(HTMLAttributes, { 
        'data-type': 'embedded-view',
        style: 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0;',
        allowfullscreen: 'true'
      })],
    ]
  },

  addCommands() {
    return {
      setEmbeddedView:
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
