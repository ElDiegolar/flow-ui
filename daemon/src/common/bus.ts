/**
 * App-level events pushed to the web UI over /api/events, alongside the PTY
 * session feed: the active context moving (pin or branch), the task board
 * changing under a sync, an integration connecting. Views subscribe to the one
 * socket the store owns instead of each polling for "did anything change".
 */
export type AppEvent =
  | { type: 'context'; context: unknown }
  | { type: 'tasks-changed'; reason: string }
  | { type: 'projects-changed'; reason: string }
  | { type: 'integrations'; status: unknown }
  | { type: 'code-graph'; status: unknown }

const listeners = new Set<(e: AppEvent) => void>()

export function onAppEvent(cb: (e: AppEvent) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function publish(e: AppEvent) {
  for (const cb of listeners) {
    try {
      cb(e)
    } catch {
      /* one bad subscriber must not starve the rest */
    }
  }
}
