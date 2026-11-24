// Bridges of the hook test page, set before any application module is
// loaded. No database, profile or network: database calls are recorded, and
// fetch answers only from the responses a test sets.
const g = window as any

g.__writes = [] as { sql: string; params: unknown[] }[]
g.db = {
    execute: async (sql: string, params: unknown[], method: string) => {
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
    getCurrentLocale: () => "en-US",
    getAllRules: () => ({}),
    getServiceConfigs: () => ({ type: 0 }),
})
g.utils = stub({
    platform: "win32",
    addWebviewErrorListener: () => () => {},
})

g.__fetches = [] as { url: string; init: string[] }[]
g.__responses = {} as Record<
    string,
    { status: number; body: string; type: string }
>
g.fetch = async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input)
    g.__fetches.push({ url, init: Object.keys(init || {}) })
    const response = g.__responses[url]
    if (!response) throw new TypeError("Failed to fetch")
    return new Response(response.body, {
        status: response.status,
        headers: { "content-type": response.type },
    })
}
