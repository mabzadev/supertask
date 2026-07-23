<template>
  <SidebarApplication
    :workspace="workspace"
    :application="application"
    @selected="selected"
  >
    <template #body>
      <ul v-if="isAppSelected(application)" class="tree__subs">
        <SidebarPageItem
          v-for="page in rootPages"
          :key="page.id"
          :page="page"
          :pages="pages"
          :application="application"
          :selected-page-id="selectedPageId"
        />
        <li v-if="rootPages.length === 0" class="tree__sub">
          <span class="tree__sub-text tree__sub-text--muted">{{ $t('documentsModule.noPages') }}</span>
        </li>
        <a class="tree__sub-add" @click.prevent="createPage(null)">
          <i class="tree__sub-add-icon iconoir-plus"></i>
          {{ $t('documentsModule.addPage') }}
        </a>
      </ul>
    </template>
  </SidebarApplication>
</template>

<script>
import { mapGetters } from 'vuex'
import { notifyIf } from '@baserow/modules/core/utils/error'
import SidebarApplication from '@baserow/modules/core/components/sidebar/SidebarApplication'
import SidebarPageItem from '@baserow/modules/documents/components/SidebarPageItem.vue'

export default {
  name: 'DocumentSidebar',
  components: { SidebarApplication, SidebarPageItem },
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
  computed: {
    pages() {
      try {
        return (this.$store.getters['documentPage/getPages'] || []).filter(
          (p) => p.document_id === this.application.id
        )
      } catch (e) {
        return []
      }
    },
    rootPages() {
      return this.pages
        .filter((p) => !p.parent_id)
        .sort((a, b) => (a.order || 0) - (b.order || 0))
    },
    selectedPageId() {
      return parseInt(this.$route.params.pageId, 10)
    },
    ...mapGetters({ isAppSelected: 'application/isSelected' }),
  },
  mounted() {
    this.fetchPagesIfEmpty()
  },
  methods: {
    async fetchPagesIfEmpty() {
      // Upon global refresh, the store is empty. We must fetch the hierarchical list.
      if (this.pages.length === 0 && this.application && this.application.id) {
        try {
          await this.$store.dispatch('documentPage/fetchAll', this.application.id)
        } catch (e) {
          // Ignore API error if document does not exist yet or user lacks permission
        }
      }
    },
    async selected(application) {
      try {
        await this.$store.dispatch('application/select', application)
      } catch (error) {
        notifyIf(error, 'workspace')
      }
    },
    selectPage(page) {
      this.$router.push({
        name: 'document-page',
        params: {
          documentId: this.application.id,
          pageId: page.id,
        },
      })
    },
    async createPage(parentId = null) {
      try {
        // Fetch pages first if not loaded
        if (this.pages.length === 0) {
          await this.$store.dispatch('documentPage/fetchAll', this.application.id)
        }
        const page = await this.$store.dispatch('documentPage/create', {
          documentId: this.application.id,
          values: {
            title: '',
            content: '',
            parent_id: parentId,
          },
        })
        this.selectPage(page)
      } catch (error) {
        this.$store.dispatch('toast/error', {
          title: 'Erreur',
          message: 'Impossible de créer la page',
        })
      }
    },
  },
}
</script>
