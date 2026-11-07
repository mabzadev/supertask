/**
 * Requests started ahead of the code that needs their response, so that a page
 * doesn't wait for one step before asking for the next one's data. A response
 * is handed out once, and only while it is fresh; otherwise the caller makes
 * its own request.
 */
const MAX_AGE_MS = 10000
const prefetched = new WeakMap()

function entries(owner) {
  let byKey = prefetched.get(owner)
  if (!byKey) {
    byKey = new Map()
    prefetched.set(owner, byKey)
  }
  return byKey
}

/** Keeps `request` (a promise) for the next `takePrefetch(owner, key)`. */
export function storePrefetch(owner, key, request) {
  // A failure reaches whoever takes the request; until then it is not unhandled.
  request.catch(() => {})
  entries(owner).set(key, { request, storedAt: Date.now() })
}

/** The fresh request stored under `key`, at most once, or null. */
export function takePrefetch(owner, key) {
  const byKey = entries(owner)
  const entry = byKey.get(key)
  if (!entry) return null
  byKey.delete(key)
  return Date.now() - entry.storedAt <= MAX_AGE_MS ? entry.request : null
}
