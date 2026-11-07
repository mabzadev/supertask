/**
 * Starts loading the views and fields of the route's table while the
 * workspaces and applications load. `selectWorkspaceDatabaseTable` then gets
 * these responses instead of asking for them only once the rest arrived.
 */
export default defineNuxtRouteMiddleware((to) => {
  const { $store } = useNuxtApp()
  const tableId = parseInt(to.params.tableId)
  if (
    !$store.getters['auth/isAuthenticated'] ||
    !Number.isInteger(tableId) ||
    $store.state.view.tableId === tableId
  ) {
    return
  }
  const table = { id: tableId }
  $store.dispatch('view/prefetchAll', table)
  $store.dispatch('field/prefetchAll', table)
})
