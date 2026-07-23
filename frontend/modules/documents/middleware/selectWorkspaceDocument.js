export default defineNuxtRouteMiddleware(async (to, from) => {
  const nuxtApp = useNuxtApp()
  const { $store } = nuxtApp

  const documentId = parseInt(to.params.documentId, 10)
  const pageId = to.params.pageId ? parseInt(to.params.pageId, 10) : null

  try {
    const documentApp = $store.getters['application/get'](documentId)
    if (documentApp) {
      // Select the workspace using commit directly to avoid calling setWorkspaceCookie
      // inside a Vuex action (which loses the Nuxt SSR context).
      const workspace = $store.getters['workspace/get'](documentApp.workspace.id)
      if (workspace) {
        $store.commit('workspace/SET_SELECTED', workspace)
      }

      if (!$store.getters['application/isSelected'](documentApp)) {
        $store.commit('application/SET_SELECTED', documentApp)
      }
    }

    // Pre-fetch the pages list if not already in store
    if (!$store.getters['documentPage/isLoaded'](documentId)) {
      await $store.dispatch('documentPage/fetchAll', documentId)
    }

    if (pageId) {
      // Ensure this specific page's content is loaded
      if (!$store.getters['documentPage/getPage'](pageId)) {
        await $store.dispatch('documentPage/fetch', pageId)
      }
    } else {
      // If we hit the root application URL without a pageId, redirect to the first page.
      const pages = $store.getters['documentPage/getPages']
        .filter((p) => p.document_id === documentId)
        .sort((a, b) => (a.order || 0) - (b.order || 0))

      if (pages.length > 0) {
        return navigateTo({
          name: 'document-page',
          params: { documentId: documentId, pageId: pages[0].id },
        })
      }
    }
  } catch (e) {
    console.error('Could not select document application', e)
  }
})
