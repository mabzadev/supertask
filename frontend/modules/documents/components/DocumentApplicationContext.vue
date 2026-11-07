<template>
  <ClientOnly>
    <Context ref="context" :overflow-scroll="true" :max-height-if-outside-viewport="true">
      <div class="context__menu-title">
        {{ application.name }} ({{ application.id }})
      </div>
      <ul class="context__menu">
        <li
          v-if="
            $hasPermission(
              'application.update',
              application,
              application.workspace.id
            )
          "
          class="context__menu-item"
        >
          <a class="context__menu-item-link" @click="handleRename()">
            <i class="context__menu-item-icon iconoir-edit-pencil"></i>
            {{ $t('sidebarApplication.rename', { type: 'document' }) }}
          </a>
        </li>
        <li
          v-if="
            $hasPermission(
              'application.delete',
              application,
              application.workspace.id
            )
          "
          class="context__menu-item context__menu-item--with-separator"
        >
          <a
            class="context__menu-item-link context__menu-item-link--delete"
            :class="{ 'context__menu-item-link--loading': deleting }"
            @click="deleteApplication()"
          >
            <i class="context__menu-item-icon iconoir-bin"></i>
            {{ $t('sidebarApplication.delete', { type: 'document' }) }}
          </a>
        </li>
      </ul>
    </Context>
  </ClientOnly>
</template>

<script>
import { notifyIf } from '@supertask/modules/core/utils/error'
import Context from '@supertask/modules/core/components/Context'

export default {
  name: 'DocumentApplicationContext',
  components: { Context },
  props: {
    application: {
      type: Object,
      required: true,
    },
    workspace: {
      type: Object,
      required: true,
    },
  },
  emits: ['rename'],
  data() {
    return {
      deleting: false,
    }
  },
  methods: {
    toggle(target, vertical, horizontal, offset) {
      this.$refs.context?.toggle(target, vertical, horizontal, offset)
    },
    hide() {
      this.$refs.context?.hide()
    },
    handleRename() {
      this.$refs.context?.hide()
      this.$emit('rename')
    },
    async deleteApplication() {
      if (this.deleting) return
      this.deleting = true
      try {
        await this.$store.dispatch('application/delete', this.application)
        await this.$store.dispatch('toast/restore', {
          trash_item_type: 'application',
          trash_item_id: this.application.id,
        })
      } catch (error) {
        notifyIf(error, 'application')
      }
      this.deleting = false
    },
  },
}
</script>
