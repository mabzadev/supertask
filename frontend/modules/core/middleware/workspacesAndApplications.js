import { getWorkspaceCookie } from '@baserow/modules/core/utils/workspace'

/**
 * This middleware will make sure that all the workspaces and applications belonging to
 * the user are fetched and added to the store.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const nuxtApp = useNuxtApp()
  const store = nuxtApp.$store
  const event = import.meta.server ? useRequestEvent() : null

  // If nuxt generate, pass this middleware
  if (import.meta.server && !event) return

  let workspaceId = getWorkspaceCookie(nuxtApp)

  // Prefer route param over cookie to avoid double selectById calls on SSR.
  // Pages can opt out or change param by doing:
  // `definePageMeta({ useRouteWorkspaceParam: 'none' }).
  const workspaceIdParam = to.meta.useRouteWorkspaceParam ?? 'workspaceId'
  if (to.params[workspaceIdParam]) {
    const routeWorkspaceId = parseInt(to.params[workspaceIdParam], 10)
    if (!isNaN(routeWorkspaceId)) {
      workspaceId = routeWorkspaceId
    }
  }

  if (store.getters['auth/isAuthenticated']) {
    // The workspaces and the applications don't depend on each other, so they are
    // fetched in parallel. Selecting the workspace (which fetches its permissions)
    // only needs the workspaces.
    await Promise.all([
      loadAndSelectWorkspace(store, workspaceId),
      store.getters['application/isLoaded']
        ? null
        : store.dispatch('application/fetchAll'),
    ])

    // If the user hasn't completed the onboarding, and the doesn't have any workspaces,
    // then redirect to the on-boarding page so that the user can create their first
    // one.
    const user = store.getters['auth/getUserObject']
    const workspaces = store.getters['workspace/getAll']
    if (!user.completed_onboarding && workspaces.length === 0) {
      return navigateTo({ name: 'onboarding' })
    }
  }
})

async function loadAndSelectWorkspace(store, workspaceId) {
  // If the workspaces haven't been loaded we will load them all.
  if (store.getters['workspace/isLoaded']) {
    return
  }
  await store.dispatch('workspace/fetchAll')

  const workspaces = store.getters['workspace/getAll']
  const workspaceExists =
    workspaces.find((w) => w.id === workspaceId) !== undefined

  // If no workspace was remembered, or the remembered workspace doesn't exist, we
  // automatically select the first one if it exists.
  if (!workspaceExists) {
    workspaceId = workspaces.length > 0 ? workspaces[0].id : null
  }

  // If there is a workspaceId we will select that workspace.
  if (workspaceId) {
    try {
      await store.dispatch('workspace/selectById', workspaceId)
    } catch {}
  }
}
