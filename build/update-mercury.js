const { createHash } = require("node:crypto")
const { existsSync, readFileSync, writeFileSync } = require("node:fs")
const path = require("node:path")

const articleDirectory = path.join(__dirname, "../dist/article")
const htmlPath = path.join(articleDirectory, "article.html")
const mercuryPath = path.join(articleDirectory, "mercury.web.js")
const articleScriptPath = path.join(articleDirectory, "article.js")
const htmlDisplayPath = "dist/article/article.html"
const mercuryDisplayPath = "dist/article/mercury.web.js"
const articleScriptDisplayPath = "dist/article/article.js"
const updateCommand = "npm run update:article-integrity"
const scriptSources = ["mercury.web.js", "article.js"]
const sha256SourcePattern = /^'sha256-[A-Za-z0-9+/]{43}='$/

class IntegrityError extends Error {}

function fail(message) {
    throw new IntegrityError(message)
}

function readRequiredFile(filePath, displayPath, missingHint = "") {
    try {
        return readFileSync(filePath)
    } catch (error) {
        if (error?.code === "ENOENT") {
            fail(
                `Missing file: ${displayPath}.${
                    missingHint ? ` ${missingHint}` : ""
                }`
            )
        }
        throw error
    }
}

function readMercurySource() {
    try {
        return readFileSync(
            require.resolve("@jocmp/mercury-parser/dist/mercury.web.js")
        )
    } catch (error) {
        if (error?.code === "MODULE_NOT_FOUND") {
            fail(
                "Missing Mercury Parser dependency. Run npm install before updating article integrity."
            )
        }
        throw error
    }
}

function calculateIntegrity(contents) {
    return `sha256-${createHash("sha256").update(contents).digest("base64")}`
}

function replaceSingle(contents, pattern, replacement, description) {
    const matches = contents.match(pattern)
    if (matches?.length !== 1) {
        fail(
            `Unexpected HTML structure in ${htmlDisplayPath}: expected exactly one ${description}, found ${
                matches?.length ?? 0
            }`
        )
    }
    return contents.replace(pattern, replacement)
}

function updateCspPolicy(policy, scripts) {
    const directivePattern = /\bscript-src-elem(?:\s+[^;]*)?/g
    const directives = policy.match(directivePattern)
    if (directives?.length !== 1) {
        fail(
            `Unexpected HTML structure in ${htmlDisplayPath}: expected exactly one script-src-elem directive, found ${
                directives?.length ?? 0
            }`
        )
    }

    const sources = directives[0]
        .slice("script-src-elem".length)
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    const unexpectedSources = sources.filter(
        source => !sha256SourcePattern.test(source)
    )
    if (
        sources.length !== scriptSources.length ||
        unexpectedSources.length > 0
    ) {
        fail(
            `Unexpected CSP sources in ${htmlDisplayPath}: script-src-elem must contain exactly ${
                scriptSources.length
            } SHA-256 hashes managed for ${scriptSources.join(
                " and "
            )}; found ${sources.join(" ") || "no sources"}`
        )
    }

    const scriptPolicy = `script-src-elem ${scripts
        .map(script => `'${script.integrity}'`)
        .join(" ")}`
    return policy.replace(directivePattern, scriptPolicy)
}

function updateHtml(html, scripts) {
    let updatedHtml = html

    for (const script of scripts) {
        const scriptTagPattern = new RegExp(
            `<script\\b[^>]*\\bsrc="${script.source.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
            )}"[^>]*>`,
            "g"
        )
        updatedHtml = replaceSingle(
            updatedHtml,
            scriptTagPattern,
            scriptTag =>
                replaceSingle(
                    scriptTag,
                    /\bintegrity="[^"]+"/g,
                    `integrity="${script.integrity}"`,
                    `integrity attribute for ${script.source}`
                ),
            `script tag for ${script.source}`
        )
    }

    return replaceSingle(
        updatedHtml,
        /<meta\b[^>]*\bhttp-equiv="Content-Security-Policy"[^>]*>/g,
        cspMeta =>
            replaceSingle(
                cspMeta,
                /\bcontent="([^"]*)"/g,
                (_, policy) => `content="${updateCspPolicy(policy, scripts)}"`,
                "content attribute in the article CSP meta tag"
            ),
        "article CSP meta tag"
    )
}

function createScripts(mercuryContents, articleScriptContents) {
    return [
        { source: "mercury.web.js", contents: mercuryContents },
        { source: "article.js", contents: articleScriptContents },
    ].map(script => ({
        source: script.source,
        integrity: calculateIntegrity(script.contents),
    }))
}

function verifyIntegrity(mercurySource) {
    const mercuryContents = readRequiredFile(
        mercuryPath,
        mercuryDisplayPath,
        `Run ${updateCommand}.`
    )
    if (!mercuryContents.equals(mercurySource)) {
        fail(
            `Stale file: ${mercuryDisplayPath} does not match the installed Mercury Parser. Run ${updateCommand}.`
        )
    }

    const articleScriptContents = readRequiredFile(
        articleScriptPath,
        articleScriptDisplayPath
    )
    const html = readRequiredFile(htmlPath, htmlDisplayPath).toString("utf8")
    const expectedHtml = updateHtml(
        html,
        createScripts(mercuryContents, articleScriptContents)
    )
    if (expectedHtml !== html) {
        fail(
            `Stale CSP or SRI hashes in ${htmlDisplayPath}. Run ${updateCommand}.`
        )
    }
}

function updateIntegrity(mercurySource) {
    const articleScriptContents = readRequiredFile(
        articleScriptPath,
        articleScriptDisplayPath
    )
    const html = readRequiredFile(htmlPath, htmlDisplayPath).toString("utf8")
    const updatedHtml = updateHtml(
        html,
        createScripts(mercurySource, articleScriptContents)
    )

    let mercuryChanged = true
    if (existsSync(mercuryPath)) {
        mercuryChanged = !readRequiredFile(
            mercuryPath,
            mercuryDisplayPath
        ).equals(mercurySource)
    }
    const htmlChanged = updatedHtml !== html

    // All input and HTML structure validation is complete before either write.
    if (mercuryChanged) writeFileSync(mercuryPath, mercurySource)
    if (htmlChanged) {
        writeFileSync(htmlPath, updatedHtml)
    }

    verifyIntegrity(mercurySource)
    console.log(
        mercuryChanged || htmlChanged
            ? "Article CSP and SRI hashes updated"
            : "Article CSP and SRI hashes are already current"
    )
}

function main() {
    const cliArguments = process.argv.slice(2)
    const checkOnly = cliArguments.includes("--check")
    const unknownArguments = cliArguments.filter(
        argument => argument !== "--check"
    )
    if (unknownArguments.length > 0) {
        fail(`Unknown argument(s): ${unknownArguments.join(", ")}`)
    }

    const mercurySource = readMercurySource()
    if (checkOnly) {
        verifyIntegrity(mercurySource)
        console.log("Article CSP and SRI hashes are valid")
    } else {
        updateIntegrity(mercurySource)
    }
}

try {
    main()
} catch (error) {
    if (error instanceof IntegrityError) {
        console.error(`Article integrity error: ${error.message}`)
    } else {
        console.error("Unexpected article integrity failure:")
        console.error(error)
    }
    process.exitCode = 1
}
