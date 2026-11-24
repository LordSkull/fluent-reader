// Tests of "Load full content": the article page (dist/article/article.html,
// with its real CSP) on synthetic fixtures, and the article view hook.
//
// Usage, from the repository root: npm run test:full-content
//   (or node tests/fork/article-full-content/run.js)
//
// The hook page is bundled with esbuild. Both pages open in hidden Electron
// windows with a temporary profile (deleted afterwards) and in-memory
// sessions. Every request that is not a local file is blocked and counted:
// no test reaches the network.
const path = require("node:path")
const fs = require("node:fs")
const os = require("node:os")
const { spawnSync } = require("node:child_process")
const esbuild = require("esbuild")

const repo = path.resolve(__dirname, "..", "..", "..")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-full-content-"))
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
        entryPoints: [path.join(__dirname, "hook-page.tsx")],
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
        path.join(dir, "hook.html"),
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
            '<body><div id="root"></div><script src="stubs.js"></script><script src="bundle.js"></script></body></html>'
    )
    const electron = require(path.join(repo, "node_modules", "electron"))
    const env = { ...process.env, FR_FULL_DIR: dir, FR_REPO: repo }
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
