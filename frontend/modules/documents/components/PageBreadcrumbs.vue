<template>
  <div class="page-breadcrumbs">
    <div
      v-for="(crumb, index) in crumbs"
      :key="crumb.id"
      class="page-breadcrumbs__item"
    >
      <a 
        class="page-breadcrumbs__link"
        @click.prevent="selectPage(crumb)"
      >
        <span v-if="crumb.icon" class="page-breadcrumbs__icon">{{ crumb.icon }}</span>
        <i v-else class="page-breadcrumbs__icon iconoir-page"></i>
        <span class="page-breadcrumbs__text">{{ crumb.title || $t('documentsModule.untitled') }}</span>
      </a>
      <span v-if="index < crumbs.length - 1" class="page-breadcrumbs__separator">/</span>
    </div>
  </div>
</template>

<script>
export default {
  name: 'PageBreadcrumbs',
  props: {
    pageId: {
      type: Number,
      required: true,
    },
    documentId: {
      type: Number,
      required: true,
    },
  },
  computed: {
    pages() {
      return this.$store.getters['documentPage/getPages'] || []
    },
    crumbs() {
      const path = []
      let currentId = this.pageId
      while (currentId) {
        const p = this.pages.find((p) => p.id === currentId)
        if (p) {
          path.unshift(p)
          currentId = p.parent_id
        } else {
          break
        }
      }
      return path
    },
  },
  methods: {
    selectPage(page) {
      if (this.pageId !== page.id) {
        this.$router.push({
          name: 'document-page',
          params: {
            documentId: this.documentId,
            pageId: page.id,
          },
        })
      }
    },
  },
}
</script>

<style scoped>
.page-breadcrumbs {
  display: flex;
  align-items: center;
  padding: 12px 48px;
  background: white;
  font-size: 14px;
}
.page-breadcrumbs__item {
  display: flex;
  align-items: center;
  color: #555;
}
.page-breadcrumbs__link {
  display: flex;
  align-items: center;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
  text-decoration: none;
  color: inherit;
  transition: background-color 0.2s;
}
.page-breadcrumbs__link:hover {
  background-color: #f2f2f2;
}
.page-breadcrumbs__icon {
  margin-right: 6px;
  font-size: 16px;
}
.page-breadcrumbs__text {
  max-width: 150px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.page-breadcrumbs__separator {
  margin: 0 4px;
  color: #ccc;
}
</style>
