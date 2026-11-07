import { VueRenderer } from '@tiptap/vue-3'
import tippy from 'tippy.js'

import RowMentionList from '@supertask/modules/documents/components/editor/RowMentionList.vue'

export default ({ searchRows }) => {
  return {
    items: async ({ query }) => {
      if (!query || query.length < 2) return []
      try {
        const results = await searchRows(query)
        return results || []
      } catch (e) {
        console.error('Failed to search rows for mention', e)
        return []
      }
    },
    render: () => {
      let popup
      let component

      return {
        onStart: (props) => {
          component = new VueRenderer(RowMentionList, {
            editor: props.editor,
            props,
          })

          if (!props.clientRect) {
            return
          }

          popup = tippy('body', {
            getReferenceClientRect: props.clientRect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
            offset: [0, 5],
          })
        },

        onUpdate(props) {
          component.updateProps(props)

          if (!props.clientRect) {
            return
          }

          popup[0].setProps({
            getReferenceClientRect: props.clientRect,
          })
        },

        onKeyDown(props) {
          if (props.event.key === 'Escape') {
            popup[0].hide()
            return true
          }
          return component.ref?.onKeyDown(props)
        },

        onExit() {
          if (component) {
            popup[0].destroy()
            component.destroy()
          }
        },
      }
    },
  }
}
