// Bridges of the test page, set before any application module is loaded.
// No database, profile or network: database calls are recorded and answered
// with empty results.
const g = window as any

g.__writes = [] as { sql: string; params: unknown[] }[]
g.__statements = 0
g.__opened = [] as string[]
g.db = {
    execute: async (sql: string, params: unknown[], method: string) => {
        g.__statements++
        if (/^\s*(insert|update|delete|replace)\b/i.test(sql))
            g.__writes.push({ sql, params })
        return method === "run" ? [1, 0] : []
    },
    batch: async (queries: unknown[]) => queries.map(() => []),
}

const stub = (overrides: any) =>
    new Proxy(overrides, {
        get: (target, key) => (key in target ? target[key] : () => undefined),
    })
g.settings = stub({
    getDefaultView: () => 1, // ViewType.List
    getViewConfigs: () => 0,
    getFilterType: () => null,
    getDefaultMenu: () => false,
    getCurrentLocale: () => "en-US",
    getAllRules: () => ({}),
    getServiceConfigs: () => ({ type: 0 }),
    getFetchInterval: () => 0,
    loadGroups: () => [],
    saveGroups: () => {},
    getDBVersion: () => "sqlite",
})
g.utils = stub({
    platform: "win32",
    openExternal: (url: string) => g.__opened.push(url),
    isFocused: () => true,
})

// A hidden window renders no frames, so requestAnimationFrame would never
// call back (Fluent UI positions and focuses menus in it): use timers.
if (process.env.FR_KBD_SHOW !== "1") {
    g.requestAnimationFrame = (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16)
    g.cancelAnimationFrame = (id: number) => clearTimeout(id)
}
