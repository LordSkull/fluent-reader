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
/* ANSA readable v2: extract only text from the publicly returned HTML. */
function extractAnsaContent(rawHtml) {
    const parsed = new DOMParser().parseFromString(rawHtml, "text/html")
    const body = parsed.querySelector(
        '.post-single-text.news-txt[itemprop="articleBody"], [itemprop="articleBody"]'
    )
    if (!body) return ""

    // ANSA can put multiple visual paragraphs inside one <p> using <br>.
    // textContent alone would erase these breaks, making the article a wall of text.
    const result = document.createElement("div")
    const paragraphs = body.querySelectorAll("p")
    const blocks = paragraphs.length ? paragraphs : [body]

    for (const block of blocks) {
        if (block.closest(".article-copyright")) continue
        const parts = [""]
        const visit = node => {
            if (node.nodeType === 3) {
                parts[parts.length - 1] += node.nodeValue || ""
                return
            }
            if (node.nodeType !== 1) return
            if (node.tagName === "BR") {
                parts.push("")
                return
            }
            if (["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "FIGURE"].includes(node.tagName)) return
            for (const child of node.childNodes) visit(child)
        }
        for (const child of block.childNodes) visit(child)

        for (const part of parts) {
            const text = part.replace(/\s+/g, " ").trim()
            if (!text) continue
            const p = document.createElement("p")
            p.textContent = text // Prevent any ANSA HTML/scripts from entering the reader.
            result.appendChild(p)
        }
    }
    return result.innerHTML
}

async function getArticle(url) {
    const html = get("a")
    if (get("m") !== "1") return html

    try {
        const host = new URL(url).hostname.toLowerCase()
        if (host === "ansa.it" || host.endsWith(".ansa.it")) {
            const content = extractAnsaContent(html)
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
