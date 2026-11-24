// Electron main process of the full-content tests: hidden windows on a
// temporary profile and in-memory sessions. Every request that is not a
// local file is blocked and recorded, so a test also proves that rendering
// an article loads no remote resource.
const { app, BrowserWindow, session } = require("electron")
const path = require("node:path")
const fs = require("node:fs")
const { pathToFileURL } = require("node:url")

const dir = process.env.FR_FULL_DIR
const repo = process.env.FR_REPO
if (!dir || !repo) throw new Error("FR_FULL_DIR and FR_REPO are required")
// Before ready: nothing is written to the default profile.
app.setPath("userData", path.join(dir, "profile"))
app.setPath("sessionData", path.join(dir, "profile"))
app.disableHardwareAcceleration()
// One window is closed before the next opens: do not quit in between.
app.on("window-all-closed", () => {})

let failed = 0
function check(name, ok, detail) {
    if (!ok) failed++
    console.log(
        `${ok ? "ok    " : "FAIL  "} ${name}${
            ok ? "" : "  " + JSON.stringify(detail)
        }`
    )
}
const wait = ms => new Promise(r => setTimeout(r, ms))
const fixture = name =>
    fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")

const ARS_URL =
    "https://arstechnica.com/science/2026/01/invented-lunar-gardening/"
const ARS_PAGED_URL =
    "https://arstechnica.com/science/2026/01/invented-paginated-story/"
const ANSA_URL = "https://www.ansa.it/sito/notizie/2026/01/inventata.html"
const OTHER_URL = "https://example.org/blog/invented-bread/"
// Inserted as text: markup in the localized notice must stay inert.
const NOTICE =
    'NOTICE-TEXT <img src="https://tracker.invalid/notice.gif" onerror="window.__fixtureScriptRan = true">'

function isolatedSession(name, blocked) {
    const ses = session.fromPartition(name) // no "persist:": in memory
    ses.webRequest.onBeforeRequest((details, callback) => {
        const local = /^(file|devtools|chrome-extension):/.test(details.url)
        if (!local) blocked.push(details.url)
        callback({ cancel: !local })
    })
    return ses
}

// The URL that src/components/article.tsx gives the article webview.
function articleUrl({ html, link, full }) {
    const page = pathToFileURL(
        path.join(repo, "dist", "article", "article.html")
    ).href
    const h = encodeURIComponent(
        '<p class="title">T</p><p class="date">D</p><article></article>'
    )
    return `${page}?a=${encodeURIComponent(
        html
    )}&h=${h}&f=&s=16&d=0&n=${encodeURIComponent(NOTICE)}&u=${link}&m=${
        full ? 1 : 0
    }`
}

// What the article page shows, read once #main is displayed.
const REPORT = `new Promise(resolve => {
    const started = Date.now()
    const read = () => {
        const main = document.getElementById("main")
        if (!main.classList.contains("show")) {
            if (Date.now() - started > 15000) return resolve(null)
            return setTimeout(read, 50)
        }
        const article = main.querySelector("article")
        const notice = main.querySelector(".content-notice")
        const attributes = new Set()
        for (const element of article.querySelectorAll("*"))
            for (const attribute of element.attributes)
                attributes.add(element.tagName + "@" + attribute.name)
        resolve({
            html: article.innerHTML,
            text: article.textContent.replace(/\\s+/g, " ").trim(),
            tags: [...new Set([...article.querySelectorAll("*")].map(e => e.tagName))],
            attributes: [...attributes],
            onAttributes: [...document.querySelectorAll("*")].flatMap(e =>
                [...e.attributes].map(a => a.name).filter(n => /^on/i.test(n))),
            links: [...article.querySelectorAll("a")].map(a => ({
                href: a.getAttribute("href"),
                text: a.textContent,
                rel: a.getAttribute("rel"),
                target: a.getAttribute("target"),
                referrerpolicy: a.getAttribute("referrerpolicy"),
            })),
            headings: [...article.querySelectorAll("h2")].map(e => e.textContent),
            olStart: article.querySelector("ol")?.getAttribute("start") ?? null,
            th: article.querySelector("th") && {
                colspan: article.querySelector("th").getAttribute("colspan"),
            },
            rowspans: article.querySelectorAll("[rowspan]").length,
            notice: notice && {
                text: notice.textContent,
                role: notice.getAttribute("role"),
                children: notice.children.length,
                beforeArticle: notice.nextElementSibling === article,
            },
            bodyClass: document.body.className,
            scriptRan: window.__fixtureScriptRan === true,
            liveElements: document.querySelectorAll(
                "script:not([src$='mercury.web.js']):not([src$='article.js']), iframe, img, object, embed, link:not([href='article.css'])"
            ).length,
        })
    }
    read()
})`

async function articlePageTests() {
    const blocked = []
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            session: isolatedSession("fr-full-content-article", blocked),
        },
    })
    const consoleErrors = []
    win.webContents.on("console-message", e => {
        if (e.level === "error") consoleErrors.push(e.message)
    })
    async function render(options) {
        blocked.length = 0
        await win.loadURL(articleUrl(options))
        const report = await win.webContents.executeJavaScript(REPORT)
        if (!report) throw new Error("the article page did not render")
        // Late requests (lazy images, beacons) would show up here.
        await wait(300)
        report.blocked = [...blocked]
        return report
    }
    const inOrder = (text, markers) => {
        let last = -1
        return markers.every(marker => {
            const index = text.indexOf(marker, last + 1)
            if (index < 0) return false
            last = index
            return true
        })
    }

    // 1. Ars Technica, recognized layout: every block, nothing else.
    const ars = await render({
        html: fixture("ars-multi-section.html"),
        link: ARS_URL,
        full: true,
    })
    const body = [
        "PARAGRAPH-ONE",
        "PARAGRAPH-TWO",
        "SECTION-ONE-HEADING",
        "PARAGRAPH-THREE",
        "PARAGRAPH-FOUR",
        "QUOTE-TEXT",
        "LIST-ITEM-ONE",
        "LIST-ITEM-TWO",
        "ORDERED-ITEM-THREE",
        "PARAGRAPH-FIVE",
        "PAGE-TWO-HEADING",
        "PARAGRAPH-SIX",
        "TABLE-HEAD-TEXT",
        "CELL-A-TEXT",
        "CELL-B-TEXT",
        "PARAGRAPH-LAST",
    ]
    check(
        "ars: every block of the body, in order, after ads and page anchors",
        inOrder(ars.text, body),
        { missing: body.filter(m => !ars.text.includes(m)) }
    )
    check(
        "ars: subheadings kept, also one that opens a block",
        JSON.stringify(ars.headings) ===
            JSON.stringify(["SECTION-ONE-HEADING", "PAGE-TWO-HEADING"]),
        ars.headings
    )
    check(
        "ars: quotes, lists and tables keep their structure",
        /<blockquote><p>QUOTE-TEXT/.test(ars.html) &&
            /<ul><li>LIST-ITEM-ONE<\/li><li>LIST-ITEM-TWO<\/li><\/ul>/.test(
                ars.html
            ) &&
            ars.olStart === "3" &&
            ars.th?.colspan === "2" &&
            ars.rowspans === 0,
        { olStart: ars.olStart, th: ars.th, rowspans: ars.rowspans }
    )
    check(
        "ars: inline emphasis kept",
        /<em>EMPHASIS-TEXT<\/em>/.test(ars.html) &&
            /<strong>STRONG-TEXT<\/strong>/.test(ars.html),
        ars.html.slice(0, 400)
    )
    const excluded = [
        "COOKIE-BANNER-TEXT",
        "NAV-TEXT",
        "DECOY-ARTICLE-TEXT",
        "HEADER-TITLE",
        "HEADER-DEK",
        "TEXT-SETTINGS-TEXT",
        "FIGURE-CAPTION-TEXT",
        "HIDDEN-TEXT",
        "INTERLUDE-TEXT",
        "RAIL-AD-TEXT",
        "MID-AD-ONE-TEXT",
        "MID-AD-TWO-TEXT",
        "INLINE-AD-TEXT",
        "ASIDE-TEXT",
        "RELATED-TEXT",
        "NEWSLETTER-TEXT",
        "SVG-TEXT",
        "NOSCRIPT-TEXT",
        "AUTHOR-BIO-TEXT",
        "COMMENTS-LINK-TEXT",
        "FOOTER-TEXT",
        "SCRIPT-REPLACED-TEXT",
    ]
    check(
        "ars: no cookie banner, ads, navigation, related, bio or comments",
        excluded.every(m => !ars.text.includes(m)),
        excluded.filter(m => ars.text.includes(m))
    )
    const safeTags = new Set(
        "P BR STRONG B EM I U S A H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE SUP SUB CODE PRE HR TABLE THEAD TBODY TFOOT TR TH TD".split(
            " "
        )
    )
    check(
        "ars: only safe elements (no script, iframe, img, svg, form, style)",
        ars.tags.every(tag => safeTags.has(tag)),
        ars.tags
    )
    const safeAttributes = new Set([
        "A@href",
        "A@rel",
        "A@target",
        "A@referrerpolicy",
        "OL@start",
        "TH@colspan",
        "TD@colspan",
        "TH@rowspan",
        "TD@rowspan",
    ])
    check(
        "ars: no event handler, style, class, id or data attribute",
        ars.attributes.every(a => safeAttributes.has(a)) &&
            ars.onAttributes.length === 0,
        { attributes: ars.attributes, on: ars.onAttributes }
    )
    check(
        "ars: links are absolute http(s), noopener, no referrer",
        ars.links.length === 2 &&
            ars.links.every(
                l =>
                    /^https?:\/\//.test(l.href) &&
                    l.rel === "noopener noreferrer" &&
                    l.target === "_blank" &&
                    l.referrerpolicy === "no-referrer"
            ) &&
            ars.links[0].href ===
                "https://arstechnica.com/science/2026/01/other-invented-story/" &&
            ars.links[1].href === "https://example.org/invented-paper?id=7",
        ars.links
    )
    check(
        "ars: javascript:, data: and blank links become plain text",
        ["JS-LINK-TEXT", "DATA-LINK-TEXT", "BLANK-LINK-TEXT"].every(
            m => ars.text.includes(m) && !ars.links.some(l => l.text === m)
        ) && !/javascript:|data:/i.test(ars.html),
        ars.links
    )
    check(
        "ars: no page script ran and no remote request was made",
        !ars.scriptRan && ars.blocked.length === 0 && ars.liveElements === 0,
        {
            scriptRan: ars.scriptRan,
            blocked: ars.blocked,
            live: ars.liveElements,
        }
    )
    check(
        "ars: complete text, so no notice and no ANSA layout",
        ars.notice === null && !/ansa-reading/.test(ars.bodyClass),
        { notice: ars.notice, bodyClass: ars.bodyClass }
    )

    // 2. Ars Technica, layout not recognized: Mercury, said to be partial.
    const unknown = await render({
        html: fixture("ars-unrecognized.html"),
        link: ARS_URL,
        full: true,
    })
    check(
        "ars unrecognized: explicit notice before the article, as plain text",
        unknown.notice?.text === NOTICE &&
            unknown.notice.role === "note" &&
            unknown.notice.children === 0 &&
            unknown.notice.beforeArticle,
        unknown.notice
    )
    check(
        "ars unrecognized: generic text still shown, nothing loaded or run",
        unknown.text.includes("UNRECOGNIZED-TEXT") &&
            !unknown.scriptRan &&
            unknown.blocked.length === 0,
        { text: unknown.text.slice(0, 120), blocked: unknown.blocked }
    )

    // 3. Ars Technica, text continued on a page that is not loaded.
    const paged = await render({
        html: fixture("ars-paginated.html"),
        link: ARS_PAGED_URL,
        full: true,
    })
    check(
        "ars paginated: first page shown with the incompleteness notice",
        paged.text.includes("PAGINATED-PARAGRAPH-TWO") &&
            paged.notice?.text === NOTICE,
        { text: paged.text, notice: paged.notice }
    )

    // 4. ANSA: its own extractor and layout, unchanged.
    const ansa = await render({
        html: fixture("ansa.html"),
        link: ANSA_URL,
        full: true,
    })
    const ansaParagraphs = (ansa.html.match(/<p>/g) || []).length
    check(
        "ansa: paragraphs split at <br>, subheading and link kept",
        inOrder(ansa.text, [
            "ANSA-UNO",
            "ANSA-DUE",
            "ANSA-LINK",
            "ANSA-TRE",
            "ANSA-SOTTOTITOLO",
            "ANSA-QUATTRO",
        ]) &&
            ansaParagraphs === 4 &&
            /<strong>ANSA-GRASSETTO<\/strong>/.test(ansa.html) &&
            ansa.links.length === 1 &&
            ansa.links[0].href ===
                "https://www.ansa.it/sito/notizie/altro.html",
        { html: ansa.html }
    )
    check(
        "ansa: related, ads and copyright dropped; ANSA layout; no notice",
        !/ANSA-CORRELATI|ANSA-PUBBLICITA|ANSA-COPYRIGHT|ANSA-COOKIE/.test(
            ansa.text
        ) &&
            /ansa-reading/.test(ansa.bodyClass) &&
            ansa.notice === null &&
            ansa.blocked.length === 0 &&
            !ansa.scriptRan,
        { text: ansa.text, bodyClass: ansa.bodyClass, notice: ansa.notice }
    )

    // 5. Other domains: Mercury, even with Ars-like class names.
    const other = await render({
        html: fixture("other-domain.html"),
        link: OTHER_URL,
        full: true,
    })
    check(
        "other domain: Mercury result (its wrapper element), no notice",
        inOrder(other.text, [
            "OTHER-PARAGRAPH-ONE",
            "OTHER-PARAGRAPH-TWO",
            "OTHER-PARAGRAPH-THREE",
        ]) &&
            other.tags.includes("DIV") &&
            other.notice === null &&
            !/ansa-reading/.test(other.bodyClass),
        { tags: other.tags, notice: other.notice }
    )

    // 6. RSS mode: the feed content as before, on Ars Technica too.
    const rssContent =
        '<p>RSS-EXCERPT-TEXT <a href="https://arstechnica.com/">x</a></p>'
    const rss = await render({ html: rssContent, link: ARS_URL, full: false })
    check(
        "rss mode: feed content shown unchanged, no extraction, no notice",
        rss.html === rssContent && rss.notice === null,
        { html: rss.html, notice: rss.notice }
    )

    // 7. Which URLs the Ars extractor applies to.
    const hosts = await win.webContents.executeJavaScript(`[
        "https://arstechnica.com/a/",
        "https://www.arstechnica.com/a/",
        "https://ARSTECHNICA.COM/a/",
        "https://arstechnica.com.example.org/a/",
        "https://notarstechnica.com/a/",
        "https://example.org/arstechnica.com/",
        "not a url",
    ].map(isArsTechnicaUrl)`)
    check(
        "ars host: arstechnica.com and subdomains only",
        JSON.stringify(hosts) ===
            JSON.stringify([true, true, true, false, false, false, false]),
        hosts
    )
    const pages = await win.webContents.executeJavaScript(`(() => {
        const page = html => {
            const t = document.createElement("template")
            t.innerHTML = html
            return hasFurtherArsPages(t.content, "https://arstechnica.com/s/2026/01/story/")
        }
        return [
            page('<a href="/s/2026/01/story/2/">2</a>'),
            page('<a href="https://arstechnica.com/s/2026/01/story/12">12</a>'),
            page('<link rel="next" href="/s/2026/01/story/3/">'),
            page('<a href="/s/2026/01/story/">1</a><a href="#page-2">2</a>'),
            page('<a href="/s/2026/01/story/1/">1</a>'),
            page('<a href="/s/2026/01/other/2/">other</a>'),
            page('<a href="https://example.org/s/2026/01/story/2/">elsewhere</a>'),
        ]
    })()`)
    check(
        "ars pages: only links to /2/ and later of the same article count",
        JSON.stringify(pages) ===
            JSON.stringify([true, true, true, false, false, false, false]),
        pages
    )
    // Chromium reports the on* attributes of the inert <template> as blocked
    // by the CSP when it parses them (as it already did for ANSA): those
    // reports are the only errors allowed.
    const otherErrors = consoleErrors.filter(
        message =>
            !/^Executing inline event handler violates the following Content Security Policy directive 'default-src 'none''.*The action has been blocked\.$/s.test(
                message
            )
    )
    check(
        "article page: no error but blocked inline handlers",
        otherErrors.length === 0,
        otherErrors
    )
    win.destroy()
}

async function hookTests() {
    const blocked = []
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            session: isolatedSession("fr-full-content-hook", blocked),
        },
    })
    win.webContents.on("console-message", e => {
        if (e.level === "error") console.log("[hook page]", e.message)
    })
    const js = code => win.webContents.executeJavaScript(code)
    await win.loadFile(path.join(dir, "hook.html"))
    for (let i = 0; i < 100 && !(await js("window.__ready === true")); i++)
        await wait(50)
    if (!(await js("window.__ready === true")))
        throw new Error("the hook page did not load")
    const respond = (status, body, type = "text/html; charset=utf-8") =>
        js(
            `window.__fetches = []; window.__responses = { ${JSON.stringify(
                ARS_URL
            )}: ${JSON.stringify({ status, body, type })} }`
        )
    const open = target =>
        js(`window.__test.open(${JSON.stringify(ARS_URL)}, "${target}")`)

    await respond(403, "<html><body>Forbidden</body></html>")
    const forbidden = await open("full")
    check(
        "hook: HTTP 403 is a load error, with no article content shown",
        forbidden.error === "MERCURY_PARSER_FAILURE" &&
            forbidden.fullContent === "" &&
            forbidden.showWebview === false &&
            forbidden.loaded === true,
        forbidden
    )

    const html = fixture("ars-multi-section.html")
    await respond(200, html)
    const ok = await open("full")
    const fetches = await js("window.__fetches")
    check(
        "hook: HTTP 200 passes the whole decoded page to the article view",
        ok.fullContent === html && ok.error === "" && ok.showWebview === true,
        { error: ok.error, length: ok.fullContent.length }
    )
    check(
        "hook: one plain request (runtime User-Agent, no custom headers)",
        fetches.length === 1 &&
            fetches[0].url === ARS_URL &&
            JSON.stringify(fetches[0].init) === JSON.stringify(["signal"]),
        fetches
    )

    await respond(200, html)
    const rss = await open("local")
    check(
        "hook: RSS mode makes no request",
        (await js("window.__fetches.length")) === 0 &&
            rss.fullContent === "" &&
            rss.showWebview === true,
        rss
    )
    check(
        "hook: nothing is written to the database, nothing leaves the window",
        (await js("window.__writes.length")) === 0 && blocked.length === 0,
        { writes: await js("window.__writes"), blocked }
    )
    win.destroy()
}

app.whenReady().then(async () => {
    try {
        await articlePageTests()
        await hookTests()
    } catch (error) {
        failed++
        console.log("FAIL  ", error?.stack || error)
    }
    console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed")
    app.exit(failed ? 1 : 0)
})
