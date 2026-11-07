import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import RichTextEditor from '@baserow/modules/core/components/editor/RichTextEditor'

// Like the collaboration extension when its shared document already holds
// content: a plugin view that changes the document while the editor is built.
const ChangesWhileCreated = Extension.create({
  name: 'changesWhileCreated',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        view(view) {
          view.dispatch(view.state.tr.insertText('synced', 1))
          return {}
        },
      }),
    ]
  },
})

describe('RichTextEditor', () => {
  test('emits a change made while the editor is being created', async () => {
    const wrapper = await mountSuspended(RichTextEditor, {
      props: {
        modelValue: { type: 'doc', content: [{ type: 'paragraph' }] },
        enableRichTextFormatting: true,
        editorExtensions: [ChangesWhileCreated],
      },
    })

    const updates = wrapper.emitted('update:modelValue')
    expect(updates).toBeTruthy()
    expect(JSON.stringify(updates.at(-1)[0])).toContain('synced')
    wrapper.unmount()
  })
})
