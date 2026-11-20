// Validates the Node-API prebuilds shipped inside better-sqlite3.
//
// better-sqlite3 contains one prebuilt binary per platform in `prebuilds/`,
// but it also ships a `binding.gyp`, so @electron/rebuild always runs node-gyp
// (and needs a C++ toolchain) even though the build would produce nothing.
// Electron Builder therefore runs with `npmRebuild: false`, and this module is
// the gate that makes skipping the rebuild safe:
//
// - `beforePack` runs before Electron Builder copies anything for a target and
//   fails the build unless the target's prebuild is present and compatible.
// - `afterPack` checks that the packaged app contains exactly that binary,
//   outside the ASAR, and on the host also loads it with the packaged Electron.
// - Run directly (npm `postinstall`), it validates the host and loads the
//   module with the installed Electron, running a query on `:memory:`.
//
// Usage:
//   node build/native-prebuilds.js                      host check
//   node build/native-prebuilds.js --target linux-x64   static check of a target
//   node build/native-prebuilds.js --packaged <appOutDir> [--target win32-x64]
"use strict"
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFileSync } = require("node:child_process")

const ROOT = path.resolve(__dirname, "..")
const MODULE = "better-sqlite3"
const MODULE_DIR = path.join(ROOT, "node_modules", MODULE)

// Only the targets this repository packages. Every entry is checked for its
// binary format and architecture; only the host can also be loaded.
const TARGETS = {
    "win32-x64": { format: "pe", machine: 0x8664 },
    "win32-arm64": { format: "pe", machine: 0xaa64 },
    "darwin-x64": { format: "macho", machine: 0x01000007 },
    "darwin-arm64": { format: "macho", machine: 0x0100000c },
    "linux-x64": { format: "elf", machine: 62 },
}

class PrebuildError extends Error {}

const fail = message => {
    throw new PrebuildError(message)
}

const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"))
const sha256 = file =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

// Electron Builder platform names to Node.js ones.
function targetKey(platform, arch) {
    const nodePlatform = platform === "mas" ? "darwin" : platform
    const key = `${nodePlatform}-${arch}`
    if (!TARGETS[key])
        fail(
            `${MODULE}: target ${key} has no checked prebuild. Checked targets: ` +
                Object.keys(TARGETS).join(", ")
        )
    return key
}

// The exact dependency and Electron versions, as pinned in package.json.
function checkVersions(electronVersion) {
    const pkg = readJson(path.join(ROOT, "package.json"))
    const wanted = (pkg.dependencies || {})[MODULE]
    if (!/^\d+\.\d+\.\d+$/.test(wanted || ""))
        fail(`${MODULE} must be pinned to an exact version, found "${wanted}"`)
    if (!fs.existsSync(path.join(MODULE_DIR, "package.json")))
        fail(`${MODULE} is not installed: run npm install`)
    const installed = readJson(path.join(MODULE_DIR, "package.json")).version
    if (installed !== wanted)
        fail(`${MODULE} ${installed} is installed, package.json pins ${wanted}`)

    const pinnedElectron = (pkg.devDependencies || {}).electron
    const electronPkg = path.join(ROOT, "node_modules", "electron")
    const installedElectron = readJson(
        path.join(electronPkg, "package.json")
    ).version
    if (installedElectron !== pinnedElectron)
        fail(
            `electron ${installedElectron} is installed, package.json pins ${pinnedElectron}`
        )
    if (electronVersion && electronVersion !== installedElectron)
        fail(
            `packaging for Electron ${electronVersion}, but ${MODULE} was validated against the installed Electron ${installedElectron}`
        )
    return { module: installed, electron: installedElectron }
}

// The Node-API version the prebuilds are compiled for.
function requiredNapiVersion() {
    const gyp = fs.readFileSync(path.join(MODULE_DIR, "binding.gyp"), "utf8")
    const match = /NAPI_VERSION=(\d+)/.exec(gyp)
    if (!match)
        fail(`${MODULE}: cannot determine the required Node-API version`)
    return Number(match[1])
}

function checkBinary(file, key) {
    const { format, machine } = TARGETS[key]
    const buf = fs.readFileSync(file)
    let found
    if (format === "pe") {
        if (buf.length < 0x40 || buf.toString("latin1", 0, 2) !== "MZ")
            fail(`${file} is not a PE file`)
        const pe = buf.readUInt32LE(0x3c)
        if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0")
            fail(`${file} is not a PE file`)
        found = buf.readUInt16LE(pe + 4)
        if (!(buf.readUInt16LE(pe + 22) & 0x2000)) fail(`${file} is not a DLL`)
    } else if (format === "elf") {
        if (buf.length < 20 || buf.readUInt32BE(0) !== 0x7f454c46)
            fail(`${file} is not an ELF file`)
        if (buf[4] !== 2 || buf[5] !== 1)
            fail(`${file} is not a 64-bit little-endian ELF file`)
        if (buf.readUInt16LE(16) !== 3) fail(`${file} is not a shared object`)
        found = buf.readUInt16LE(18)
    } else {
        if (buf.length < 16 || buf.readUInt32LE(0) !== 0xfeedfacf)
            fail(`${file} is not a 64-bit Mach-O file`)
        if (buf.readUInt32LE(12) !== 8) fail(`${file} is not a Mach-O bundle`)
        found = buf.readUInt32LE(4)
    }
    if (found !== machine)
        fail(
            `${file} is built for machine 0x${found.toString(
                16
            )}, ${key} needs 0x${machine.toString(16)}`
        )
    // A Node-API addon registers through napi_register_module_v1; an addon
    // tied to one Node.js ABI would use node_module_register instead.
    if (
        !buf.includes("napi_register_module_v1") ||
        !buf.includes("node_api_module_get_api_version_v1")
    )
        fail(`${file} is not a Node-API addon`)
    if (buf.includes("node_module_register"))
        fail(`${file} depends on a specific Node.js ABI`)
}

function prebuildPath(key) {
    return path.join(MODULE_DIR, "prebuilds", `${key}.node`)
}

// Production dependencies other than better-sqlite3 must not need a native
// build, since nothing rebuilds them.
function checkOtherNativeDependencies() {
    const seen = new Set()
    const native = []
    const visit = (name, fromDir) => {
        let dir = null
        for (let d = fromDir; ; d = path.dirname(d)) {
            const candidate = path.join(d, "node_modules", name)
            if (fs.existsSync(path.join(candidate, "package.json"))) {
                dir = candidate
                break
            }
            if (path.dirname(d) === d) break
        }
        if (!dir) fail(`production dependency ${name} is not installed`)
        if (seen.has(dir)) return
        seen.add(dir)
        const pkg = readJson(path.join(dir, "package.json"))
        const scripts = pkg.scripts || {}
        const reasons = []
        if (fs.existsSync(path.join(dir, "binding.gyp")))
            reasons.push("binding.gyp")
        if (pkg.gypfile === true) reasons.push("gypfile")
        if (pkg.binary) reasons.push("node-pre-gyp binary")
        for (const s of ["preinstall", "install", "postinstall"])
            if (scripts[s]) reasons.push(`${s} script`)
        if (hasNodeFiles(dir)) reasons.push(".node files")
        if (reasons.length && name !== MODULE)
            native.push(`${name} (${reasons.join(", ")})`)
        const deps = {
            ...(pkg.dependencies || {}),
            ...(pkg.optionalDependencies || {}),
        }
        for (const dep of Object.keys(deps)) {
            if (pkg.optionalDependencies && dep in pkg.optionalDependencies) {
                try {
                    visit(dep, dir)
                } catch (e) {
                    if (!(e instanceof PrebuildError)) throw e
                }
            } else visit(dep, dir)
        }
    }
    const root = readJson(path.join(ROOT, "package.json"))
    for (const dep of Object.keys(root.dependencies || {})) visit(dep, ROOT)
    if (native.length)
        fail(
            "these production dependencies need a native build, which " +
                `npmRebuild: false would skip: ${native.join("; ")}`
        )
    return [...seen].map(d => path.relative(ROOT, d))
}

function hasNodeFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue
        const p = path.join(dir, entry.name)
        if (
            entry.isDirectory() ? hasNodeFiles(p) : entry.name.endsWith(".node")
        )
            return true
    }
    return false
}

// Electron in Node mode: no app, no profile, no windows.
function electronAsNodeEnv() {
    const env = { ...process.env }
    for (const k of Object.keys(env))
        if (/^ELECTRON_/i.test(k) || /^NODE_OPTIONS$/i.test(k)) delete env[k]
    env.ELECTRON_RUN_AS_NODE = "1"
    return env
}

function runElectronAsNode(exe, moduleDir) {
    const env = electronAsNodeEnv()
    const probe = `
        const Database = require(${JSON.stringify(moduleDir)})
        const db = new Database(":memory:")
        db.exec("create table t (n integer)")
        db.prepare("insert into t values (?)").run(42)
        const row = db.prepare("select sqlite_version() as version, n from t").get()
        db.close()
        process.stdout.write(JSON.stringify({
            electron: process.versions.electron,
            napi: Number(process.versions.napi),
            platform: process.platform,
            arch: process.arch,
            sqlite: row.version,
            value: row.n,
            loaded: Object.keys(require.cache).filter(f => f.endsWith(".node")),
        }))
    `
    let out
    try {
        out = execFileSync(exe, ["-e", probe], {
            env,
            cwd: ROOT,
            encoding: "utf8",
            timeout: 60000,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        })
    } catch (e) {
        fail(
            `${MODULE} failed to load with ${exe}: ${(e.stderr || e.message)
                .toString()
                .trim()}`
        )
    }
    let result
    try {
        result = JSON.parse(out)
    } catch {
        fail(`unexpected output from ${exe}: ${out}`)
    }
    if (result.value !== 42) fail(`SQLite query returned ${result.value}`)
    return result
}

function electronNapiVersion() {
    const out = execFileSync(
        require("electron"),
        ["-p", "process.versions.napi"],
        {
            env: electronAsNodeEnv(),
            encoding: "utf8",
            timeout: 60000,
            windowsHide: true,
        }
    )
    return Number(out.trim())
}

const isHost = key => key === `${process.platform}-${process.arch}`

// Checks one target. Loading is only possible for the host.
function validateTarget(key, electronVersion) {
    const versions = checkVersions(electronVersion)
    const file = prebuildPath(key)
    if (!fs.existsSync(file)) fail(`${MODULE}: missing prebuild ${file}`)
    checkBinary(file, key)
    const dependencies = checkOtherNativeDependencies()
    const required = requiredNapiVersion()
    const report = {
        target: key,
        ...versions,
        prebuild: path.relative(ROOT, file),
        sha256: sha256(file),
        requiredNapi: required,
        dependencies,
    }
    if (isHost(key)) {
        const run = runElectronAsNode(require("electron"), MODULE_DIR)
        if (run.electron !== versions.electron)
            fail(
                `loaded by Electron ${run.electron}, ${versions.electron} expected`
            )
        const loaded = run.loaded.map(f => path.resolve(f).toLowerCase())
        if (
            loaded.length !== 1 ||
            loaded[0] !== path.resolve(file).toLowerCase()
        )
            fail(`expected ${file} to be loaded, got ${run.loaded.join(", ")}`)
        report.electronNapi = run.napi
        report.runtime = { sqlite: run.sqlite, loaded: run.loaded[0] }
    } else {
        // The Node-API version only depends on the Electron version.
        report.electronNapi = electronNapiVersion()
        report.runtime = "not loaded: not the host target"
    }
    if (!(report.electronNapi >= required))
        fail(
            `Electron ${versions.electron} provides Node-API ${report.electronNapi}, ${MODULE} needs ${required}`
        )
    return report
}

function contextKeys(context) {
    const { Arch } = require("electron-builder")
    const arch = Arch[context.arch]
    if (arch === "universal")
        return ["x64", "arm64"].map(a =>
            targetKey(context.electronPlatformName, a)
        )
    return [targetKey(context.electronPlatformName, arch)]
}

function log(message) {
    console.log(`  • ${MODULE} ${message}`)
}

async function beforePack(context) {
    const electronVersion = context.packager.config.electronVersion
    for (const key of contextKeys(context)) {
        const r = validateTarget(key, electronVersion)
        log(
            `${r.module} prebuild verified for ${key} (Electron ${r.electron}, Node-API ${r.electronNapi} >= ${r.requiredNapi}, ` +
                (typeof r.runtime === "string"
                    ? r.runtime
                    : `loaded, SQLite ${r.runtime.sqlite}`) +
                ")"
        )
    }
}

// Dependencies of Electron Builder, resolved through it.
const builderModule = name =>
    require(require.resolve(name, {
        paths: [path.dirname(require.resolve("app-builder-lib/package.json"))],
    }))

// Resources directory and executable of a packaged app.
function packagedPaths(appOutDir, key, productName, linuxExecutable) {
    if (key.startsWith("darwin")) {
        const app = path.join(appOutDir, `${productName}.app`)
        return {
            resources: path.join(app, "Contents", "Resources"),
            exe: path.join(app, "Contents", "MacOS", productName),
        }
    }
    return {
        resources: path.join(appOutDir, "resources"),
        exe: path.join(
            appOutDir,
            key.startsWith("win32") ? `${productName}.exe` : linuxExecutable
        ),
    }
}

// The packaged app must contain the validated binary, unpacked from the ASAR.
async function verifyPackaged({ resources, exe }, key) {
    const asar = builderModule("@electron/asar")
    const archive = path.join(resources, "app.asar")
    if (!fs.existsSync(archive)) fail(`missing ${archive}`)
    const entries = new Set(
        asar.listPackage(archive).map(e => e.replace(/\\/g, "/"))
    )
    const base = `/node_modules/${MODULE}`
    for (const f of ["package.json", "lib/index.js", "lib/binding.js"])
        if (!entries.has(`${base}/${f}`)) fail(`${archive} lacks ${base}/${f}`)
    const packagedVersion = JSON.parse(
        asar.extractFile(
            archive,
            path.join("node_modules", MODULE, "package.json")
        )
    ).version
    const { module } = checkVersions()
    if (packagedVersion !== module)
        fail(`packaged ${MODULE} is ${packagedVersion}, expected ${module}`)
    const inArchive = path.join(
        "node_modules",
        MODULE,
        "prebuilds",
        `${key}.node`
    )
    if (!asar.statFile(archive, inArchive).unpacked)
        fail(`${inArchive} is not marked as unpacked in ${archive}`)
    const unpacked = path.join(resources, "app.asar.unpacked", inArchive)
    if (!fs.existsSync(unpacked)) fail(`missing unpacked prebuild ${unpacked}`)
    if (sha256(unpacked) !== sha256(prebuildPath(key)))
        fail(`${unpacked} differs from the validated prebuild`)
    checkBinary(unpacked, key)
    const report = { target: key, module, unpacked, sha256: sha256(unpacked) }

    if (!isHost(key)) {
        report.runtime = "not loaded: not the host target"
        return report
    }
    // Never start the application itself: without the RunAsNode fuse the
    // executable would ignore ELECTRON_RUN_AS_NODE and open its profile.
    const fuses = builderModule("@electron/fuses")
    const wire = await fuses.getCurrentFuseWire(exe)
    // Fuse states are ASCII digits: "1" (49) means enabled.
    if (wire[fuses.FuseV1Options.RunAsNode] !== 49) {
        report.runtime = "not loaded: the RunAsNode fuse is disabled"
        return report
    }
    const run = runElectronAsNode(
        exe,
        path.join(resources, "app.asar", "node_modules", MODULE)
    )
    // Electron reports the path inside the archive and loads the file marked
    // as unpacked, checked above, from app.asar.unpacked.
    const expected = path.join(resources, "app.asar", inArchive)
    const loaded = run.loaded.map(f => path.resolve(f).toLowerCase())
    if (
        loaded.length !== 1 ||
        loaded[0] !== path.resolve(expected).toLowerCase()
    )
        fail(`expected ${expected} to be loaded, got ${run.loaded.join(", ")}`)
    report.runtime = { electron: run.electron, sqlite: run.sqlite }
    return report
}

async function afterPack(context) {
    const { packager, appOutDir } = context
    for (const key of contextKeys(context)) {
        const paths = packagedPaths(
            appOutDir,
            key,
            packager.appInfo.productFilename,
            packager.executableName
        )
        const r = await verifyPackaged(paths, key)
        log(
            `packaged prebuild verified for ${key} (` +
                (typeof r.runtime === "string"
                    ? r.runtime
                    : `loaded by packaged Electron ${r.runtime.electron}, SQLite ${r.runtime.sqlite}`) +
                ")"
        )
    }
}

module.exports = { beforePack, afterPack, validateTarget, verifyPackaged }

if (require.main === module) {
    const argv = process.argv.slice(2)
    const option = name => {
        const i = argv.indexOf(name)
        return i >= 0 ? argv[i + 1] : undefined
    }
    const target = option("--target")
    const packaged = option("--packaged")
    ;(async () => {
        const key = target
            ? targetKey(...target.split(/-(?=[^-]+$)/))
            : targetKey(process.platform, process.arch)
        let report
        if (packaged) {
            // Names as configured in electron-builder.yml.
            const config = fs.readFileSync(
                path.join(ROOT, "electron-builder.yml"),
                "utf8"
            )
            const productName = /^productName:\s*(.+)$/m.exec(config)[1].trim()
            const linuxExecutable = readJson(
                path.join(ROOT, "package.json")
            ).name
            report = await verifyPackaged(
                packagedPaths(
                    path.resolve(packaged),
                    key,
                    productName,
                    linuxExecutable
                ),
                key
            )
        } else {
            report = validateTarget(key)
        }
        console.log(JSON.stringify(report, null, 4))
    })().catch(e => {
        console.error(`${MODULE} prebuild check failed: ${e.message}`)
        process.exit(1)
    })
}
