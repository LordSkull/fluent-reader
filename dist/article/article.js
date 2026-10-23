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
    return (await Mercury.parse(url, { html })).content || ""
}

document.documentElement.style.fontSize = get("s") + "px"
let font = get("f")
if (font) document.body.style.fontFamily = `"${font}"`
let url = get("u")
getArticle(url).then(article => {
    let domParser = new DOMParser()
    let dom = domParser.parseFromString(get("h"), "text/html")
    dom.getElementsByTagName("article")[0].innerHTML = article
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
