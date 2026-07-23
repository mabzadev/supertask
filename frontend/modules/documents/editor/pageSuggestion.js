import { VueRenderer } from '@tiptap/vue-3'
import tippy from 'tippy.js'

import PageMentionList from '@baserow/modules/documents/components/editor/PageMentionList.vue'

export default ({ pages }) => {
  return {
    items: ({ query }) => {
      const pageList = typeof pages === 'function' ? pages() : pages
      if (!pageList || !pageList.length) return []
      return pageList
        .filter((item) =>
          item.title.toLowerCase().includes(query.toLowerCase())
        )
        .slice(0, 10)
    },
    render: () => {
      let popup
      let component

      return {
        onStart: (props) => {
          component = new VueRenderer(PageMentionList, {
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
