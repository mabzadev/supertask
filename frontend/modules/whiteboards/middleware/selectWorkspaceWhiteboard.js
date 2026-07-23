export default defineNuxtRouteMiddleware(async (to) => {
  const { $store } = useNuxtApp()
  const whiteboardId = Number(to.params.whiteboardId)
  const canvasId = Number(to.params.canvasId)
  const application = $store.getters['application/get'](whiteboardId)
  if (application) {
    const workspace = $store.getters['workspace/get'](application.workspace.id)
    if (workspace) $store.commit('workspace/SET_SELECTED', workspace)
    $store.commit('application/SET_SELECTED', application)
  }
  if (!$store.getters['whiteboardCanvas/isLoaded'](whiteboardId)) {
    await $store.dispatch('whiteboardCanvas/fetchAll', whiteboardId)
  }
  if (!$store.getters['whiteboardCanvas/get'](canvasId)) await $store.dispatch('whiteboardCanvas/fetch', canvasId)
})
