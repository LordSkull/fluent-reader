// Keyboard and accessibility test of the copies of an article, on the real
// list feed, cards and context menu, in an Electron window.
//
// Usage, from the repository root:
//   npm run test:duplicates:keyboard
//   (or node tests/fork/cross-source-duplicates/keyboard/run.js)
//
// The page is bundled with esbuild and opened in one hidden window with a
// temporary profile (deleted afterwards) and an in-memory session. Database
// calls are stubbed: no SQLite file, user profile or network is used. Set
// FR_KBD_SHOW=1 to see the window.
const path = require("node:path")
const fs = require("node:fs")
const os = require("node:os")
const { spawnSync } = require("node:child_process")
const esbuild = require("esbuild")

const repo = path.resolve(__dirname, "..", "..", "..", "..")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-duplicates-kbd-"))
try {
    // The stubs are a script of their own, run before the page: the
    // package's sideEffects list would drop a bare import of them.
    esbuild.buildSync({
        entryPoints: [path.join(__dirname, "stubs.ts")],
        bundle: true,
        format: "iife",
        target: "chrome120",
        outfile: path.join(dir, "stubs.js"),
        logLevel: "warning",
    })
    esbuild.buildSync({
        entryPoints: [path.join(__dirname, "page.tsx")],
        bundle: true,
        // Renderer modules import Node packages; the page has Node
        // integration, as webpack's renderer bundle has polyfills.
        platform: "node",
        format: "iife",
        target: "chrome120",
        outfile: path.join(dir, "bundle.js"),
        nodePaths: [path.join(repo, "node_modules")],
        alias: {
            lovefield: path.join(
                repo,
                "vendor",
                "lovefield",
                "lovefield.min.js"
            ),
        },
        define: { "process.env.NODE_ENV": '"development"' },
        loader: { ".json": "json" },
        jsx: "transform",
        logLevel: "warning",
    })
    fs.writeFileSync(
        path.join(dir, "page.html"),
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
            '<body><div id="root"></div><script src="stubs.js"></script><script src="bundle.js"></script></body></html>'
    )
    const electron = require(path.join(repo, "node_modules", "electron"))
    const env = { ...process.env, FR_KBD_DIR: dir }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const result = spawnSync(electron, [path.join(__dirname, "main.js")], {
        stdio: "inherit",
        cwd: dir,
        env,
        timeout: 120000,
    })
    process.exitCode = result.status ?? 1
} finally {
    fs.rmSync(dir, { recursive: true, force: true })
}
