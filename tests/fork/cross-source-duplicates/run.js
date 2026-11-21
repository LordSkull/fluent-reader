// Tests of grouping copies of the same article across RSS sources: the
// identity criterion, conformance fixtures and the feeds, navigation and
// article states of the real renderer modules.
//
// Usage, from the repository root: npm run test:duplicates
//   (or node tests/fork/cross-source-duplicates/run.js)
//
// The suite is bundled with esbuild and runs in Electron's Node runtime
// (ELECTRON_RUN_AS_NODE), against an in-memory SQLite database. No window,
// profile or network is used.
const path = require("node:path")
const fs = require("node:fs")
const os = require("node:os")
const { spawnSync } = require("node:child_process")
const esbuild = require("esbuild")

const repo = path.resolve(__dirname, "..", "..", "..")
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-duplicates-"))
const outfile = path.join(outDir, "suite.js")
try {
    esbuild.buildSync({
        entryPoints: [path.join(__dirname, "suite.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20",
        outfile,
        external: ["better-sqlite3"],
        nodePaths: [path.join(repo, "node_modules")],
        // As in webpack.config.js.
        alias: {
            lovefield: path.join(
                repo,
                "vendor",
                "lovefield",
                "lovefield.min.js"
            ),
        },
        define: { __REPO__: JSON.stringify(repo) },
        loader: { ".json": "json" },
        jsx: "transform",
        logLevel: "warning",
    })
    const electron = require(path.join(repo, "node_modules", "electron"))
    const result = spawnSync(electron, [outfile], {
        stdio: "inherit",
        cwd: repo,
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            NODE_PATH: path.join(repo, "node_modules"),
            // The public conformance contract.
            FR_FIXTURES: path.join(
                repo,
                "contracts",
                "cross-source-duplicates"
            ),
        },
    })
    process.exitCode = result.status ?? 1
} finally {
    fs.rmSync(outDir, { recursive: true, force: true })
}
