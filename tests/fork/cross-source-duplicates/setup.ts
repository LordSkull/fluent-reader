// Test environment of the renderer modules used by the suite: an in-memory
// SQLite database with the app's migrations (dist/drizzle) behind the same
// db:execute and db:batch contract as src/main/db.ts, and stubbed bridges.
// No profile, file database, network or window is used.
import fs from "node:fs"
import path from "node:path"

// better-sqlite3 uses its Node-API prebuild, loaded here by Electron's Node
// runtime (ELECTRON_RUN_AS_NODE), as the app's main process loads it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3")

declare const __REPO__: string

export const sqlite = new Database(":memory:")
const migrations = path.join(__REPO__, "dist", "drizzle")
for (const file of fs
    .readdirSync(migrations)
    .filter(f => f.endsWith(".sql"))
    .sort()) {
    const text = fs.readFileSync(path.join(migrations, file), "utf8")
    for (const stmt of text.split("--> statement-breakpoint"))
        if (stmt.trim()) sqlite.exec(stmt)
}

// Every statement run, in order, to check that grouping writes nothing.
export const executed: string[] = []

type Query = { sql: string; params: unknown[]; method: string }

// As executeQuery in src/main/db.ts: raw rows, in the actual column order.
function executeQuery({ sql, params, method }: Query): unknown[] {
    executed.push(sql)
    const stmt = sqlite.prepare(sql)
    if (method === "run") {
        const result = stmt.run(params)
        return [result.changes, Number(result.lastInsertRowid)]
    }
    const convert = (row: unknown[]) =>
        row?.map(v => (typeof v === "bigint" ? Number(v) : v))
    stmt.raw()
    if (method === "get") return convert(stmt.get(params) as unknown[])
    return (stmt.all(params) as unknown[][]).map(convert)
}

// As db:batch in src/main/db.ts: all the statements, or none.
const executeBatch = sqlite.transaction((queries: Query[]) =>
    queries.map(executeQuery)
)

const g = globalThis as any
g.db = {
    execute: async (sql: string, params: unknown[], method: string) =>
        // Structured clone, as across IPC.
        executeQuery({ sql, params: structuredClone(params), method }),
    batch: async (queries: Query[]) => executeBatch(structuredClone(queries)),
}

// ---- bridges
let groupId = 0
const settingsOverrides: any = {
    getDBVersion: () => "sqlite",
    // As the settings bridge does when nothing is stored.
    getFilterType: () => null,
    getAllRules: () => ({}),
    getServiceConfigs: () => ({ type: 0 }),
    getFetchInterval: () => 0,
    getDefaultMenu: () => false,
    allocateGroupId: () => groupId++,
    loadGroups: () => [],
    saveGroups: () => {},
    getCurrentLocale: () => "it",
}
const utilsOverrides: any = {
    platform: "win32",
    isFocused: () => false,
}
// Any other bridge function does nothing.
const stub = (overrides: any) =>
    new Proxy(overrides, {
        get: (target, key) => (key in target ? target[key] : () => undefined),
    })
g.window = g
g.self = g
// React's scheduler would keep the process alive with a MessageChannel.
g.MessageChannel = undefined
g.settings = stub(settingsOverrides)
g.utils = stub(utilsOverrides)
g.innerWidth = 1024
// scripts/utils.ts creates a DOMParser when it is loaded; these tests never
// parse HTML, so any use is an error.
g.DOMParser = class {
    parseFromString(): never {
        throw new Error("DOMParser is not available in this suite")
    }
}
if (!g.document) {
    g.document = {
        body: { classList: { add() {}, remove() {} } },
        documentElement: { style: {} },
    }
}
