<template>
  <li class="tree__sub" :class="{ active: selectedPageId === page.id }">
    <div class="tree__action tree__action--has-toggle">
      <a
        class="tree__action-toggle"
        :class="{ 'tree__action-toggle--expanded': expanded }"
        @click.prevent="toggleExpand"
      >
        <i v-if="hasChildren" class="supertask-icon-chevron-right"></i>
      </a>
      <a
        class="tree__sub-link"
        :title="page.title || $t('documentsModule.untitled')"
        @click.prevent="selectPage(page)"
      >
        <span v-if="page.icon" class="tree__sub-icon-emoji">{{ page.icon }}</span>
        <i v-else class="tree__sub-icon iconoir-page"></i>
        <Editable
          ref="rename"
          :value="page.title || $t('documentsModule.untitled')"
          @change="renamePage(page, $event)"
        ></Editable>
      </a>

      <a
        class="tree__options"
        @click="$refs.context.toggle($event.currentTarget, 'bottom', 'right', 0)"
        @mousedown.stop
      >
        <i class="supertask-icon-more-vertical"></i>
      </a>

      <Context ref="context" overflow-scroll max-height-if-outside-viewport>
        <div class="context__menu-title">
          {{ page.title || $t('documentsModule.untitled') }} ({{ page.id }})
        </div>
        <ul class="context__menu">
          <li class="context__menu-item">
            <a class="context__menu-item-link" @click="enableRename()">
              <i class="context__menu-item-icon iconoir-edit-pencil"></i>
              {{ $t('action.rename') }}
            </a>
          </li>
          <li class="context__menu-item">
            <a class="context__menu-item-link" @click="createSubPage()">
              <i class="context__menu-item-icon iconoir-plus"></i>
              {{ $t('documentsModule.addPage') }}
            </a>
          </li>
          <li class="context__menu-item">
            <a
              class="context__menu-item-link context__menu-item-link--delete"
              :class="{ 'context__menu-item-link--loading': deleteLoading }"
              @click="deletePage()"
            >
              <i class="context__menu-item-icon iconoir-bin"></i>
              {{ $t('action.delete') }}
            </a>
          </li>
        </ul>
      </Context>
    </div>
    
    <ul v-show="expanded && hasChildren" class="tree__subs">
      <SidebarPageItem
        v-for="childPage in children"
        :key="childPage.id"
        :page="childPage"
        :pages="pages"
        :application="application"
        :selected-page-id="selectedPageId"
      />
    </ul>
  </li>
</template>

<script>
import { notifyIf } from '@supertask/modules/core/utils/error'

export default {
  name: 'SidebarPageItem',
  props: {
    page: {
      type: Object,
      required: true,
    },
    pages: {
      type: Array,
      required: true,
    },
    application: {
      type: Object,
      required: true,
    },
    selectedPageId: {
      type: Number,
      required: false,
      default: null,
    },
  },
  data() {
    return {
      expanded: false,
      deleteLoading: false,
    }
  },
  computed: {
    children() {
      return this.pages
        .filter((p) => p.parent_id === this.page.id)
        .sort((a, b) => (a.order || 0) - (b.order || 0))
    },
    hasChildren() {
      return this.children.length > 0
    },
  },
  watch: {
    selectedPageId: {
      immediate: true,
      handler(newId) {
        this.checkExpanded(newId)
      },
    },
    pages: {
      handler() {
        this.checkExpanded(this.selectedPageId)
      },
    },
  },
  methods: {
    checkExpanded(newId) {
      if (this.isAncestorOfSelected(newId, this.page.id)) {
        this.expanded = true
      }
    },
    toggleExpand() {
      if (this.hasChildren) {
        this.expanded = !this.expanded
      }
    },
    selectPage(page) {
      if (this.selectedPageId !== page.id) {
        this.$router.push({
          name: 'document-page',
          params: {
            documentId: this.application.id,
            pageId: page.id,
          },
        })
      }
    },
    isAncestorOfSelected(selectedId, currentId) {
      if (!selectedId) return false
      const selectedPage = this.pages.find(p => p.id === selectedId)
      if (!selectedPage || !selectedPage.parent_id) return false
      if (selectedPage.parent_id === currentId) return true
      return this.isAncestorOfSelected(selectedPage.parent_id, currentId)
    },
    enableRename() {
      this.$refs.context.hide()
      this.$refs.rename.edit()
    },
    async renamePage(page, event) {
      if (event.value === page.title) return
      try {
        await this.$store.dispatch('documentPage/update', {
          pageId: page.id,
          values: { title: event.value },
        })
      } catch (error) {
        this.$refs.rename.set(event.oldValue)
        notifyIf(error, 'page')
      }
    },
    async createSubPage() {
      this.$refs.context.hide()
      try {
        const newPage = await this.$store.dispatch('documentPage/create', {
          documentId: this.application.id,
          values: {
            title: '',
            parent_id: this.page.id,
          },
        })
        this.expanded = true
        this.selectPage(newPage)
      } catch (error) {
        notifyIf(error, 'page')
      }
    },
    async deletePage() {
      if (this.deleteLoading) return
      this.deleteLoading = true
      try {
        await this.$store.dispatch('documentPage/delete', this.page.id)
        // Auto navigate if the deleted page was selected
        if (this.selectedPageId === this.page.id) {
          const firstPage = this.pages.find(p => p.id !== this.page.id && !p.parent_id)
          if (firstPage) {
            this.selectPage(firstPage)
          } else {
            // Need a dashboard redirect or another fallback
            this.$router.push({ name: 'dashboard' })
          }
        }
      } catch (error) {
        notifyIf(error, 'page')
      }
      this.deleteLoading = false
    },
  },
}
</script>

<style scoped>
.tree__sub-icon-emoji {
  margin-right: 8px;
  font-size: 14px;
}
</style>
