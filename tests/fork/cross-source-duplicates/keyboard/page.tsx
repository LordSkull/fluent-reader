// Test page: the real list feed, cards, badge and context menu of the app, on
// a store with three sources and a group of three copies.
// The bridges are stubbed by stubs.ts, loaded before this page.
import * as React from "react"
import { createRoot } from "react-dom/client"
import { Provider } from "react-redux"
import { createStore, applyMiddleware } from "redux"
import { thunk as thunkMiddleware } from "redux-thunk"
import intl from "react-intl-universal"
import { rootReducer } from "../../../../src/scripts/reducer"
import { Feed } from "../../../../src/components/feeds/feed"
import { ContextMenu } from "../../../../src/components/context-menu"
import {
    RSSSource,
    initSourcesSuccess,
} from "../../../../src/scripts/models/source"
import { RSSItem } from "../../../../src/scripts/models/item"
import { ALL, initFeedSuccess } from "../../../../src/scripts/models/feed"
import { selectFeedView } from "../../../../src/scripts/models/feed-view"
import type { ViewType } from "../../../../src/schema-types"
import enUS from "../../../../src/scripts/i18n/en-US.json"

const g = window as any
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)
const NAMES = ["ANSA Lombardia", "ANSA Veneto", "ANSA Emilia-Romagna"]
const REGIONS = ["lombardia", "veneto", "emiliaromagna"]

const sources: any = {}
NAMES.forEach((name, sid) => {
    const source = new RSSSource(`https://feeds.example/${sid}.xml`, name)
    source.sid = sid
    source.unreadCount = 0
    sources[sid] = source
})

let nextId = 100
function article(story: number, sid: number, time: number): RSSItem {
    return {
        _id: nextId--,
        source: sid,
        guid: `guid-${story}-${sid}`,
        title: `Notizia ${story}, titolo di prova per il raggruppamento`,
        link: `https://www.ansa.it/${REGIONS[sid]}/notizie/2026/11/20/notizia-${story}_${sid}.html`,
        date: new Date(time),
        fetchedDate: new Date(time),
        content: "",
        snippet: `Testo della notizia numero ${story}, con abbastanza parole e caratteri per essere considerato significativo.`,
        hasRead: false,
        starred: false,
        hidden: false,
        notify: false,
    } as RSSItem
}

// Story 0: three copies; story 1: one article; story 2: two copies.
const items = [
    article(0, 0, T0),
    article(0, 1, T0 - 5000),
    article(0, 2, T0 - 9000),
    article(1, 0, T0 - 3600000),
    article(2, 1, T0 - 7200000),
    article(2, 2, T0 - 7203000),
]

const store = createStore(rootReducer, applyMiddleware(thunkMiddleware))
store.dispatch(initSourcesSuccess(sources))
store.dispatch(initFeedSuccess(store.getState().feeds[ALL], items))

function describe(el: Element): string {
    if (!el || el === document.body) return "body"
    const card = el.closest("[data-iid]")
    if (card && el === card) return "card:" + card.getAttribute("data-iid")
    if (el.closest(".ms-ContextualMenu"))
        return "menu:" + (el.textContent || "").trim()
    if (card) return "in-card:" + el.tagName.toLowerCase()
    return el.tagName.toLowerCase()
}

g.__test = {
    ids: items.map(i => i._id),
    describe: () => describe(document.activeElement),
    hasFocus: () => document.hasFocus(),
    state: () => {
        const state = store.getState()
        const view = selectFeedView(state, ALL)
        const menus = [...document.querySelectorAll(".ms-ContextualMenu")]
        return {
            itemId: state.page.itemId,
            menuType: state.app.contextMenu.type,
            menuItem: (state.app.contextMenu.target as any)?.[0]?._id ?? null,
            menus: menus.length,
            menuTexts: menus.map(m =>
                [...m.querySelectorAll("[role^=menuitem]")].map(e =>
                    (e.textContent || "").trim()
                )
            ),
            visible: view.visible,
            read: items.map(i => state.items[i._id].hasRead),
            starred: items.map(i => state.items[i._id].starred),
            writes: g.__writes,
            opened: g.__opened,
        }
    },
    focusCard: (iid: number) => {
        const el = document.querySelector<HTMLElement>(`[data-iid="${iid}"]`)
        el.focus()
        return describe(document.activeElement)
    },
    badge: (iid: number) => {
        const b = document.querySelector<HTMLElement>(
            `[data-iid="${iid}"] button`
        )
        if (!b) return null
        const r = b.getBoundingClientRect()
        return {
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            tag: b.tagName.toLowerCase(),
            type: b.getAttribute("type"),
            label: b.getAttribute("aria-label"),
            haspopup: b.getAttribute("aria-haspopup"),
            expanded: b.getAttribute("aria-expanded"),
            tabIndex: b.tabIndex,
            focusable: b.getAttribute("data-is-focusable"),
            text: b.textContent,
        }
    },
    // Roles and names of the entries of the open menus.
    roles: () =>
        [...document.querySelectorAll(".ms-ContextualMenu [role]")]
            .map(e => [
                e.getAttribute("role"),
                (e.getAttribute("aria-label") || e.textContent || "").trim(),
                e.getAttribute("aria-checked"),
                e.getAttribute("aria-haspopup"),
            ])
            .filter(([role]) => role.startsWith("menuitem")),
    keys: [] as string[],
}
document.addEventListener("keydown", e => g.__test.keys.push(e.key), true)

intl.init({ currentLocale: "en-US", locales: { "en-US": enUS } }).then(() => {
    createRoot(document.getElementById("root")).render(
        <Provider store={store}>
            <div style={{ height: "500px", width: "400px" }}>
                <Feed feedId={ALL} viewType={1 as ViewType} />
            </div>
            <ContextMenu />
        </Provider>
    )
    setTimeout(() => (g.__ready = true), 300)
})
