// Test page of the article view hook (useArticleView): which content
// "Load full content" receives for an HTTP response, without a webview.
import * as React from "react"
import { createRoot } from "react-dom/client"
import { useArticleView } from "../../../src/components/utils/hooks/useArticleView"
import { RSSItem } from "../../../src/scripts/models/item"
import { SourceOpenTarget } from "../../../src/scripts/models/source"

const g = window as any
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

function Probe(props: { item: RSSItem; target: SourceOpenTarget }) {
    const view = useArticleView(props.item, props.target)
    g.__view = {
        loadFull: view.loadFull,
        showWebview: view.showWebview,
        fullContent: view.fullContent,
        loaded: view.loaded,
        error: view.error,
    }
    return null
}

const targets = {
    local: SourceOpenTarget.Local,
    full: SourceOpenTarget.FullContent,
}

g.__test = {
    // Mounts the hook for one article and returns its state once the
    // request settles (or after a short wait if none is made).
    async open(link: string, target: keyof typeof targets) {
        g.__view = null
        const node = document.createElement("div")
        document.body.appendChild(node)
        const root = createRoot(node)
        const item = { _id: 1, link, content: "" } as RSSItem
        root.render(<Probe item={item} target={targets[target]} />)
        for (let i = 0; i < 50; i++) {
            await wait(20)
            const view = g.__view
            if (view && (view.fullContent || view.error)) break
        }
        const view = g.__view
        root.unmount()
        node.remove()
        return view
    },
}
g.__ready = true
