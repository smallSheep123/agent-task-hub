export class SessionDiscoveryCache {
  constructor({ ttlMs = 8000, initialWaitMs = 1200, onError = () => {} } = {}) {
    this.ttlMs = Math.max(10, Number(ttlMs) || 8000)
    this.initialWaitMs = Math.max(0, Number(initialWaitMs) || 0)
    this.onError = onError
    this.sources = new Map()
  }

  #source(name) {
    if (!this.sources.has(name)) this.sources.set(name, { sessions: [], initialized: false, refreshedAt: 0, inFlight: null })
    return this.sources.get(name)
  }

  #refresh(name, loader, source) {
    if (source.inFlight) return source.inFlight
    source.inFlight = Promise.resolve()
      .then(loader)
      .then((sessions) => {
        source.sessions = Array.isArray(sessions) ? sessions : []
        source.initialized = true
        source.refreshedAt = Date.now()
        return source.sessions
      })
      .catch((error) => {
        source.initialized = true
        source.refreshedAt = Date.now()
        this.onError(name, error)
        return source.sessions
      })
      .finally(() => { source.inFlight = null })
    return source.inFlight
  }

  async get(name, loader, { force = false } = {}) {
    const source = this.#source(name)
    const stale = force || !source.initialized || Date.now() - source.refreshedAt >= this.ttlMs
    const refresh = stale ? this.#refresh(name, loader, source) : source.inFlight
    if (source.initialized) return source.sessions
    if (!refresh || this.initialWaitMs === 0) return source.sessions
    return Promise.race([
      refresh,
      new Promise((resolve) => setTimeout(() => {
        source.initialized = true
        resolve(source.sessions)
      }, this.initialWaitMs)),
    ])
  }

  remember(name, session) {
    const source = this.#source(name)
    const id = String(session?.id || "")
    if (!id) return
    source.sessions = [session, ...source.sessions.filter((item) => String(item?.id || "") !== id)]
    source.initialized = true
    source.refreshedAt = Date.now()
  }

  snapshot(name) { return [...this.#source(name).sessions] }
}
