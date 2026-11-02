// After an update, a page that was left open may ask for files that no longer exist.
// Reload once to get the new version (at most once a minute, so it can never loop).

const STALE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Setting up fake worker failed/i

export const isUpdateError = (e: unknown) => STALE.test(String((e as Error)?.message ?? e))

export function reloadForUpdate() {
  try {
    const last = Number(sessionStorage.getItem('reloaded-for-update') ?? 0)
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem('reloaded-for-update', String(Date.now()))
  } catch { /* private mode: reload anyway */ }
  window.location.reload()
  return true
}
