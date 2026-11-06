/**
 * If this middleware is added to a page, it will load the pending jobs
 * for the user from the server in order to show them in the UI.
 */
export default defineNuxtRouteMiddleware(async () => {
  const nuxtApp = useNuxtApp()
  const store = nuxtApp.$store
  const event = import.meta.server ? useRequestEvent() : null

  // If nuxt generate, pass this middleware
  if (import.meta.server && !event) return

  if (
    // If the user is not authenticated we can't fetch unfinished jobs.
    store.getters['auth/isAuthenticated'] &&
    //  If the unfinished jobs haven't been loaded we will load them all.
    !store.getters['job/isLoaded'] &&
    !store.getters['job/isLoading']
  ) {
    // In the browser the page doesn't wait for the jobs: they show up in the UI
    // as soon as they're known (`fetchAllUnfinished` handles its own errors). A
    // server render must have them before its state is serialized.
    const fetching = store.dispatch('job/fetchAllUnfinished')
    if (import.meta.server) {
      await fetching
    }
  }
})
