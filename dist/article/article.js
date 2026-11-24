function get(name) {
    if (name = (new RegExp('[?&]' + encodeURIComponent(name) + '=([^&]*)')).exec(location.search))
        return decodeURIComponent(name[1]);
}
let dir = get("d")
if (dir === "1") {
    document.body.classList.add("rtl")
} else if (dir === "2") {
    document.body.classList.add("vertical")
    document.body.addEventListener("wheel", (evt) => {
        document.scrollingElement.scrollLeft -= evt.deltaY;
    });
}
/* ANSA semantic reading v3: explicit safe-element/attribute reconstruction. */
function extractAnsaContent(rawHtml, articleUrl) {
    // Unlike DOMParser('text/html'), <template> keeps the source DOM inactive.
    // Nothing parsed here is appended to the live document.
    const template = document.createElement("template")
    template.innerHTML = rawHtml
    const source = template.content.querySelector(
        '.post-single-text.news-txt[itemprop="articleBody"], [itemprop="articleBody"]'
    )
    if (!source) return ""

    // Intentionally NO IMG, IFRAME, VIDEO, AUDIO, SVG or CSS, even if the
    // article contains them: loading those resources would weaken privacy.
    const allowed = new Set([
        "P", "BR", "STRONG", "B", "EM", "I", "U", "S", "A",
        "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI",
        "BLOCKQUOTE", "SUP", "SUB", "CODE", "PRE", "HR"
    ])
    const discard = new Set([
        "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "IMG",
        "PICTURE", "SOURCE", "VIDEO", "AUDIO", "TRACK", "SVG", "MATH",
        "FORM", "INPUT", "BUTTON", "SELECT", "OPTION", "TEXTAREA",
        "OBJECT", "EMBED", "CANVAS", "LINK", "META", "BASE"
    ])
    const article = document.createElement("div")

    const appendSafe = (node, parent) => {
        if (node.nodeType === 3) {
            parent.appendChild(document.createTextNode(node.nodeValue || ""))
            return
        }
        if (node.nodeType !== 1) return
        if (node.matches(".article-copyright, .article-related, [data-slot-id]")) return
        const tag = node.tagName.toUpperCase()
        if (discard.has(tag)) return

        let destination = parent
        if (allowed.has(tag)) {
            if (tag === "A") {
                // Do not preserve onclick, style, id, class, tracking attributes,
                // data URLs or javascript: URLs. Only HTTP(S) links survive.
                let href
                try {
                    const rawHref = node.getAttribute("href")
                    href = rawHref && rawHref.trim() ? new URL(rawHref, articleUrl) : null
                } catch {
                    href = null
                }
                if (href && (href.protocol === "https:" || href.protocol === "http:")) {
                    destination = document.createElement("a")
                    destination.setAttribute("href", href.href)
                    destination.setAttribute("rel", "noopener noreferrer")
                    destination.setAttribute("referrerpolicy", "no-referrer")
                    destination.setAttribute("target", "_blank")
                }
            } else {
                destination = document.createElement(tag.toLowerCase())
                if (tag === "OL") {
                    const start = Number(node.getAttribute("start"))
                    if (Number.isInteger(start) && start > 1 && start < 10000) {
                        destination.setAttribute("start", String(start))
                    }
                }
            }
        }

        if (destination !== parent) parent.appendChild(destination)
        if (tag !== "BR" && tag !== "HR") {
            for (const child of node.childNodes) appendSafe(child, destination)
        }
    }
    for (const child of source.childNodes) appendSafe(child, article)

    // ANSA often uses <br> as paragraph separators inside a single <p>.
    // Split into actual paragraphs while reconstructing allowed inline markup.
    for (const p of Array.from(article.querySelectorAll("p"))) {
        if (!p.querySelector("br")) continue
        const replacement = document.createDocumentFragment()
        let paragraph = document.createElement("p")
        const flush = () => {
            if (paragraph.textContent.replace(/\u00a0/g, " ").trim()) {
                replacement.appendChild(paragraph)
            }
            paragraph = document.createElement("p")
        }
        const walk = (node, wrappers) => {
            if (node.nodeType === 3) {
                let parent = paragraph
                for (const wrapper of wrappers) {
                    const copy = wrapper.cloneNode(false) // only our sanitized nodes
                    parent.appendChild(copy)
                    parent = copy
                }
                parent.appendChild(document.createTextNode(node.nodeValue || ""))
                return
            }
            if (node.nodeType !== 1) return
            if (node.tagName === "BR") {
                flush()
                return
            }
            for (const child of node.childNodes) walk(child, [...wrappers, node])
        }
        for (const child of p.childNodes) walk(child, [])
        flush()
        p.replaceWith(replacement)
    }

    return article.textContent.trim() ? article.innerHTML : ""
}

/* Ars Technica full text: explicit safe-element/attribute reconstruction. */
function isArsTechnicaUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase()
        return host === "arstechnica.com" || host.endsWith(".arstechnica.com")
    } catch {
        return false
    }
}

// True if the page links to a further page of the same article (/<path>/2/),
// whose text is not in this document.
function hasFurtherArsPages(root, articleUrl) {
    const base = new URL(articleUrl)
    const path = base.pathname.replace(/\/?$/, "/")
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pagePath = new RegExp(`^${escaped}([2-9]|[1-9][0-9]+)/?$`)
    for (const link of root.querySelectorAll('a[href], link[rel~="next"][href]')) {
        let target
        try {
            target = new URL(link.getAttribute("href"), articleUrl)
        } catch {
            continue
        }
        if (target.hostname === base.hostname && pagePath.test(target.pathname)) {
            return true
        }
    }
    return false
}

// Ars splits the body of an article into several .post-content blocks, with
// ads between them. Mercury's Ars extractor needs a single .post-content
// match, so it falls back to the whole <main> (bio, comments link, ...) and
// its header cleaning drops a subheading that opens a block. Returns null if
// the layout is not recognized.
function extractArsTechnicaContent(rawHtml, articleUrl) {
    // Unlike DOMParser('text/html'), <template> keeps the source DOM inactive.
    // Nothing parsed here is appended to the live document.
    const template = document.createElement("template")
    template.innerHTML = rawHtml
    const root = template.content
    const source = Array.from(root.querySelectorAll("article")).find(article =>
        article.querySelector(".post-content")
    )
    if (!source) return null
    const blocks = Array.from(source.querySelectorAll(".post-content")).filter(
        block => !block.parentElement.closest(".post-content")
    )

    // Intentionally NO IMG, IFRAME, VIDEO, AUDIO, SVG or CSS: loading those
    // resources would weaken privacy. Figures go with their captions.
    const allowed = new Set([
        "P", "BR", "STRONG", "B", "EM", "I", "U", "S", "A",
        "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI",
        "BLOCKQUOTE", "SUP", "SUB", "CODE", "PRE", "HR",
        "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD"
    ])
    const discard = new Set([
        "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "FRAME", "IMG",
        "PICTURE", "SOURCE", "VIDEO", "AUDIO", "TRACK", "SVG", "MATH",
        "FORM", "INPUT", "BUTTON", "SELECT", "OPTION", "TEXTAREA",
        "OBJECT", "EMBED", "CANVAS", "LINK", "META", "BASE", "DIALOG",
        "FIGURE", "FIGCAPTION", "ASIDE", "NAV", "HEADER", "FOOTER"
    ])
    // Ads, in-body interludes (videos), page anchors, galleries, newsletter
    // and related-story boxes, consent banners and hidden elements.
    const excluded = [
        ".ad", ".ad-wrapper",
        ".ars-interlude-container", ".page-anchor-wrapper", ".sidebar",
        '[class*="newsletter"]', '[class*="related"]', '[class*="sponsor"]',
        '[class*="gallery"]', '[class*="lightbox"]',
        '[class*="cookie"]', '[id*="cookie"]',
        '[class*="consent"]', '[id*="consent"]',
        "[hidden]", '[aria-hidden="true"]'
    ].join(",")
    const article = document.createElement("div")

    const appendSafe = (node, parent) => {
        if (node.nodeType === 3) {
            parent.appendChild(document.createTextNode(node.nodeValue || ""))
            return
        }
        if (node.nodeType !== 1) return
        const tag = node.tagName.toUpperCase()
        if (discard.has(tag) || node.matches(excluded)) return

        let destination = parent
        if (allowed.has(tag)) {
            if (tag === "A") {
                // Only HTTP(S) links survive, without any source attribute.
                let href
                try {
                    const rawHref = node.getAttribute("href")
                    href = rawHref && rawHref.trim() ? new URL(rawHref, articleUrl) : null
                } catch {
                    href = null
                }
                if (href && (href.protocol === "https:" || href.protocol === "http:")) {
                    destination = document.createElement("a")
                    destination.setAttribute("href", href.href)
                    destination.setAttribute("rel", "noopener noreferrer")
                    destination.setAttribute("referrerpolicy", "no-referrer")
                    destination.setAttribute("target", "_blank")
                }
            } else {
                destination = document.createElement(tag.toLowerCase())
                if (tag === "OL") {
                    const start = Number(node.getAttribute("start"))
                    if (Number.isInteger(start) && start > 1 && start < 10000) {
                        destination.setAttribute("start", String(start))
                    }
                } else if (tag === "TD" || tag === "TH") {
                    for (const name of ["colspan", "rowspan"]) {
                        const span = Number(node.getAttribute(name))
                        if (Number.isInteger(span) && span > 1 && span <= 100) {
                            destination.setAttribute(name, String(span))
                        }
                    }
                }
            }
        }

        if (destination !== parent) parent.appendChild(destination)
        if (tag !== "BR" && tag !== "HR") {
            for (const child of node.childNodes) appendSafe(child, destination)
        }
    }
    for (const block of blocks) {
        for (const child of block.childNodes) appendSafe(child, article)
    }

    // Drop what excluded content left empty (paragraphs of images, ads).
    const emptiable = "p, h2, h3, h4, h5, h6, li, ul, ol, blockquote, a, strong, b, em, i, u, s, sup, sub, code, pre"
    for (const element of Array.from(article.querySelectorAll(emptiable)).reverse()) {
        if (!element.textContent.replace(/ /g, " ").trim()) element.remove()
    }

    if (!article.textContent.trim()) return null
    return {
        content: article.innerHTML,
        complete: !hasFurtherArsPages(root, articleUrl),
    }
}

// Set when the text shown may not be the whole article.
let incompleteContent = false

async function getArticle(url) {
    const html = get("a")
    if (get("m") !== "1") return html

    try {
        const host = new URL(url).hostname.toLowerCase()
        if (host === "ansa.it" || host.endsWith(".ansa.it")) {
            const content = extractAnsaContent(html, url)
            if (content) {
                document.body.classList.add("ansa-reading")
                return content
            }
        }
    } catch (error) {
        console.warn("ANSA extraction fallback:", error)
    }

    if (isArsTechnicaUrl(url)) {
        try {
            const ars = extractArsTechnicaContent(html, url)
            if (ars) {
                incompleteContent = !ars.complete
                return ars.content
            }
        } catch (error) {
            console.warn("Ars Technica extraction fallback:", error)
        }
        // Layout not recognized: Mercury's generic result may be only part
        // of the article, and is shown as such.
        incompleteContent = true
    }
    return (await Mercury.parse(url, { html })).content || ""
}

document.documentElement.style.fontSize = get("s") + "px"
let font = get("f")
if (font) document.body.style.fontFamily = `"${font}"`
let url = get("u")
getArticle(url).then(article => {
    let domParser = new DOMParser()
    let dom = domParser.parseFromString(get("h"), "text/html")
    let articleEl = dom.getElementsByTagName("article")[0]
    articleEl.innerHTML = article
    if (incompleteContent) {
        let notice = dom.createElement("p")
        notice.className = "content-notice"
        notice.setAttribute("role", "note")
        notice.textContent =
            get("n") || "This text may not be the whole article."
        articleEl.before(notice)
    }
    let baseEl = dom.createElement('base')
    baseEl.setAttribute('href', url.split("/").slice(0, 3).join("/"))
    dom.head.append(baseEl)
    for (let s of dom.getElementsByTagName("script")) {
        s.parentNode.removeChild(s)
    }
    for (let e of dom.querySelectorAll("*[src]")) {
        e.src = e.src
    }
    for (let e of dom.querySelectorAll("*[href]")) {
        e.href = e.href
    }
    let main = document.getElementById("main")
    main.innerHTML = dom.body.innerHTML
    main.classList.add("show")
})
