import { sqlite, executed } from "./setup"
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { createStore, applyMiddleware } from "redux"
import { thunk as thunkMiddleware } from "redux-thunk"
import { rootReducer } from "../../../src/scripts/reducer"
import {
    DuplicateCandidate,
    DuplicateGroups,
    GENERIC_PATHS,
    NAMED_ENTITIES,
    codePointLength,
    timeOf,
    MAX_DATE_DIFFERENCE_MS,
    MIN_SNIPPET_LENGTH,
    MIN_SNIPPET_WORDS,
    SYNTHETIC_GUID_PREFIX,
    decodeEntities,
    groupDuplicates,
    identityOf,
    isSameArticle,
    normalizeText,
    publisherOf,
} from "../../../src/scripts/duplicates"
import {
    computeFeedView,
    selectFeedView,
    FeedView,
} from "../../../src/scripts/models/feed-view"
import {
    RSSSource,
    SourceOpenTarget,
    insertSource,
    initSources,
    HIDE_SOURCE,
    UNHIDE_SOURCE,
} from "../../../src/scripts/models/source"
import {
    RSSItem,
    insertItems,
    markRead,
    markAllRead,
    toggleStarred,
    toggleHidden,
    fetchItemsSuccess,
    updateItemContent,
} from "../../../src/scripts/models/item"
import {
    ALL,
    SOURCE,
    FilterType,
    RSSFeed,
    FeedFilter,
    initFeeds,
    loadMore,
} from "../../../src/scripts/models/feed"
import {
    showItem,
    showOffsetItem,
    canShowOffsetItem,
    selectSources,
    switchFilter,
    toggleFilter,
} from "../../../src/scripts/models/page"
import { CAMERA_ODG_GUID_PREFIX } from "../../../src/scripts/rss-normalizers/camera-odg"
import { ActionStatus } from "../../../src/scripts/utils"
import { openItemMenu } from "../../../src/scripts/models/app"
import { Card } from "../../../src/components/cards/card"
import { duplicateMenuItems } from "../../../src/components/cards/duplicates"

const FIXTURES = JSON.parse(
    fs.readFileSync(
        path.join(process.env.FR_FIXTURES, "conformance.json"),
        "utf8"
    )
)

const SECOND = 1000
const MINUTE = 60 * SECOND
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)

// ------------------------------------------------------------ helpers

const fixtureItem = (raw: any) => ({ ...raw })

function groupsAsArrays(groups: Map<number, number[]>) {
    return [...groups.values()].sort((a, b) => b[0] - a[0])
}

function shuffled<T>(list: T[], seed: number): T[] {
    const out = [...list]
    let s = seed
    for (let i = out.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) % 2147483648
        const j = s % (i + 1)
        ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
}

const isWrite = (sql: string) =>
    /^\s*(insert|update|delete|replace|create|drop|alter)\b/i.test(sql)

const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
}

const REGIONS = ["lombardia", "veneto", "emiliaromagna"]
const NAMES = [
    "ANSA Lombardia",
    "ANSA Veneto",
    "ANSA Emilia-Romagna",
    "Il Post",
]

async function freshStore() {
    sqlite.exec("DELETE FROM items; DELETE FROM sources;")
    executed.length = 0
    const store = createStore(rootReducer, applyMiddleware(thunkMiddleware))
    const dispatch = store.dispatch as any
    await dispatch(initSources())
    for (let i = 0; i < NAMES.length; i++) {
        await dispatch(
            insertSource(
                new RSSSource(`https://feeds.example/${i}.xml`, NAMES[i])
            )
        )
    }
    await dispatch(initSources())
    return store
}

const title = (n: number) =>
    `Notizia ${n}, titolo di prova per il raggruppamento`
const snippet = (n: number) =>
    `Testo della notizia numero ${n}, con abbastanza parole e caratteri per essere considerato significativo dal criterio.`

// A copy of story n in source sid (0-2: ANSA regions, 3: Il Post).
function copy(n: number, sid: number, time: number, extra: any = {}): RSSItem {
    const link =
        sid < 3
            ? `https://www.ansa.it/${REGIONS[sid]}/notizie/2026/11/20/notizia-${n}_${sid}.html`
            : `https://www.ilpost.it/2026/11/20/notizia-${n}/`
    return {
        source: sid,
        guid: `guid-${n}-${sid}-${time}`,
        title: title(n),
        link,
        date: new Date(time),
        fetchedDate: new Date(time),
        content: `<p>${snippet(n)}</p>`,
        snippet: snippet(n),
        hasRead: false,
        starred: false,
        hidden: false,
        notify: false,
        ...extra,
    } as RSSItem
}

// Scenario of the pagination tests: 40 stories, 20 minutes apart; story k
// has three ANSA copies when k % 3 == 0, two when k % 3 == 1, and only an
// Il Post article otherwise. 81 records; story 24 straddles the first page.
function scenario(): RSSItem[] {
    const items: RSSItem[] = []
    for (let k = 0; k < 40; k++) {
        const t = T0 - k * 20 * MINUTE
        if (k % 3 === 0) {
            items.push(copy(k, 0, t), copy(k, 1, t - 5 * SECOND))
            items.push(copy(k, 2, t - 10 * SECOND))
        } else if (k % 3 === 1) {
            items.push(copy(k, 0, t), copy(k, 1, t - 7 * SECOND))
        } else {
            items.push(copy(k, 3, t))
        }
    }
    return items
}

// Every record, in the order of feeds.
const sqlOrder = (): number[] =>
    (
        sqlite
            .prepare("SELECT _id FROM items ORDER BY date DESC, _id DESC")
            .all() as any[]
    ).map(r => r._id)

const row = (id: number): any =>
    sqlite.prepare("SELECT * FROM items WHERE _id = ?").get(id)

// The ids of story n in the store, newest first.
function storyIds(state: any, n: number): number[] {
    return Object.values(state.items as Record<number, RSSItem>)
        .filter(i => i.title === title(n))
        .sort((a, b) => b.date.getTime() - a.date.getTime() || b._id - a._id)
        .map(i => i._id)
}

// Structural invariants of a view over a feed.
function checkView(feed: RSSFeed, view: FeedView) {
    const visible = new Set(view.visible)
    assert.equal(visible.size, view.visible.length, "entries are unique")
    // Entries keep the order of feed.iids.
    let at = -1
    for (const id of view.visible) {
        const next = feed.iids.indexOf(id)
        assert.ok(next > at, "entries follow feed order")
        at = next
    }
    // Every loaded article is an entry or a copy in the group of one.
    for (const id of feed.iids) {
        const rep = view.representativeOf.get(id)
        if (rep === undefined) assert.ok(visible.has(id), `${id} is shown`)
        else {
            assert.ok(visible.has(rep), `${id} is shown under ${rep}`)
            assert.ok(!visible.has(id) || rep === id)
        }
    }
    for (const [rep, ids] of view.groups) {
        assert.equal(ids[0], rep)
        assert.ok(ids.length >= 2)
        const sources = ids.map(id => feed.iids.includes(id))
        assert.ok(sources.every(Boolean), "groups only hold loaded articles")
    }
}

// ------------------------------------------------------------ identity

test("constants are the documented ones", () => {
    assert.equal(
        MAX_DATE_DIFFERENCE_MS,
        FIXTURES.constants.MAX_DATE_DIFFERENCE_MS
    )
    assert.equal(MIN_SNIPPET_LENGTH, FIXTURES.constants.MIN_SNIPPET_LENGTH)
    assert.equal(MIN_SNIPPET_WORDS, FIXTURES.constants.MIN_SNIPPET_WORDS)
    assert.equal(
        SYNTHETIC_GUID_PREFIX,
        FIXTURES.constants.SYNTHETIC_GUID_PREFIX
    )
    // Camera agenda articles are synthetic, so never grouped.
    assert.ok(CAMERA_ODG_GUID_PREFIX.startsWith(SYNTHETIC_GUID_PREFIX))
})

for (const c of FIXTURES.cases) {
    test(`conformance: ${c.name}`, () => {
        const items = c.items.map(fixtureItem)
        const byId = new Map(items.map((i: any) => [i._id, i]))
        const expected = [...c.groups].sort((a, b) => b[0] - a[0])
        // The result does not depend on the input order.
        for (let seed = 1; seed <= 6; seed++) {
            const input = seed === 1 ? items : shuffled(items, seed)
            const { members, representativeOf } = groupDuplicates(input)
            assert.deepEqual(groupsAsArrays(members), expected, `seed ${seed}`)
            for (const ids of expected)
                for (const id of ids)
                    assert.equal(representativeOf.get(id), ids[0])
            assert.equal(
                representativeOf.size,
                expected.reduce((n, g) => n + g.length, 0)
            )
        }
        for (const [a, b, same] of c.pairs) {
            assert.equal(
                isSameArticle(byId.get(a), byId.get(b)),
                same,
                `${a}~${b}`
            )
            assert.equal(
                isSameArticle(byId.get(b), byId.get(a)),
                same,
                `${b}~${a}`
            )
        }
        // Dates as stored (milliseconds) and as in memory (Date) agree.
        for (const kind of ["ms", "date"]) {
            const converted = items.map((i: any) => {
                const time = Date.parse(i.date)
                return {
                    ...i,
                    date: Number.isFinite(time)
                        ? kind === "ms"
                            ? time
                            : new Date(time)
                        : i.date,
                }
            })
            assert.deepEqual(
                groupsAsArrays(groupDuplicates(converted).members),
                expected,
                kind
            )
        }
    })
}

const cp = (u: string) => String.fromCodePoint(parseInt(u.slice(2), 16))
const hex = (c: string) =>
    "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")

test("contract: exact entity table, white space and invisible characters", () => {
    const table = Object.fromEntries(
        Object.entries(NAMED_ENTITIES).map(([name, value]) => [
            name,
            hex(value),
        ])
    )
    assert.deepEqual(table, FIXTURES.namedEntities)
    for (const [name, u] of Object.entries(FIXTURES.namedEntities))
        assert.equal(decodeEntities(`&${name};`), cp(u as string), name)
    // Names are case-sensitive, a semicolon is required, unknown ones stay.
    assert.equal(
        decodeEntities("&AMP; &Amp; &amp &foo;"),
        "&AMP; &Amp; &amp &foo;"
    )
    for (const u of FIXTURES.whitespace) {
        const expected = FIXTURES.invisible.includes(u) ? "ab" : "a b"
        assert.equal(normalizeText(`a${cp(u)}${cp(u)}b`), expected, u)
    }
    for (const u of FIXTURES.invisible)
        assert.equal(normalizeText(`a${cp(u)}b`), "ab", u)
    // Neither white space nor invisible: kept.
    for (const u of ["U+0085", "U+180E", "U+200E", "U+00B7"])
        assert.equal(normalizeText(`a${cp(u)}b`), `a${cp(u)}b`, u)
    assert.deepEqual(FIXTURES.genericPaths, [...GENERIC_PATHS])
    // Lengths are counted in code points.
    const face = String.fromCodePoint(0x1f600)
    assert.equal(codePointLength(`a${face}b`), 3)
    assert.equal(codePointLength(String.fromCharCode(0xd800) + "a"), 2)
})

test("contract: normalization vectors", () => {
    for (const [input, expected] of FIXTURES.normalization)
        assert.equal(normalizeText(input), expected, JSON.stringify(input))
    assert.equal(normalizeText(42), null)
    assert.equal(normalizeText(null), null)
})

test("contract: publisher vectors", () => {
    for (const [link, expected] of FIXTURES.publishers)
        assert.equal(publisherOf(link), expected, JSON.stringify(link))
})

test("contract: date vectors; Date objects and stored milliseconds", () => {
    for (const [input, expected] of FIXTURES.dates)
        assert.equal(timeOf(input), expected, JSON.stringify(input))
    assert.equal(timeOf(new Date(T0)), T0)
    assert.equal(timeOf(new Date(NaN)), null)
    // Formats Date.parse accepts, and the contract does not.
    for (const s of [
        "Fri, 20 Nov 2026 12:00:00 GMT",
        "2026-11-20",
        "2026/11/20 12:00",
        "2026-11-20T12:00:00",
    ]) {
        assert.ok(Number.isFinite(Date.parse(s)), s)
        assert.equal(timeOf(s), null, s)
    }
    // Every case date of the contract is valid, and equals Date.parse.
    for (const c of FIXTURES.cases)
        for (const item of c.items)
            if (typeof item.date === "string" && timeOf(item.date) !== null)
                assert.equal(timeOf(item.date), Date.parse(item.date))
})

test("keyboard: Shift+F10 and the Menu key, only, open the card menu", () => {
    const key = (key: string, mods: any = {}) =>
        ({
            key,
            shiftKey: false,
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            ...mods,
        } as any)
    assert.ok(Card.isContextMenuKey(key("ContextMenu")))
    assert.ok(Card.isContextMenuKey(key("F10", { shiftKey: true })))
    for (const k of [
        key("F10"),
        key("F10", { shiftKey: true, ctrlKey: true }),
        key("F10", { shiftKey: true, altKey: true }),
        key("F10", { shiftKey: true, metaKey: true }),
        key("m"),
        key("Enter"),
        key("ArrowDown"),
    ])
        assert.ok(!Card.isContextMenuKey(k), JSON.stringify(k))
    // The card handler: the menu, not the shortcuts, and no default action.
    const calls: string[] = []
    const props: any = {
        feedId: ALL,
        item: { _id: 7 },
        source: {},
        shortcuts: (_: any, e: any) => calls.push("shortcut:" + e.key),
        contextMenu: (fid: string, item: any) =>
            calls.push(`menu:${fid}:${item._id}`),
    }
    const handlers = Card.bindEventsToProps(props)
    const event = (k: string, mods: any = {}) => {
        const e: any = { ...key(k, mods), nativeEvent: key(k, mods) }
        e.preventDefault = () => calls.push("prevent")
        e.stopPropagation = () => calls.push("stop")
        return e
    }
    handlers.onKeyDown(event("F10", { shiftKey: true }))
    handlers.onKeyDown(event("ContextMenu"))
    handlers.onKeyDown(event("s"))
    assert.deepEqual(calls, [
        "prevent",
        "stop",
        `menu:${ALL}:7`,
        "prevent",
        "stop",
        `menu:${ALL}:7`,
        "shortcut:s",
    ])
    // From the keyboard the menu is placed below the card.
    const card = { getBoundingClientRect: () => ({ left: 12, bottom: 80 }) }
    const action: any = openItemMenu({ _id: 7 } as any, ALL, {
        key: "F10",
        currentTarget: card,
    } as any)
    assert.deepEqual(action.position, [12, 80])
    assert.equal(action.event, undefined)
    const store = createStore(rootReducer, applyMiddleware(thunkMiddleware))
    store.dispatch(action)
    assert.deepEqual(store.getState().app.contextMenu.position, [12, 80])
    // From the mouse, as before: the event.
    const mouse: any = openItemMenu({ _id: 7 } as any, ALL, {
        nativeEvent: "native",
    } as any)
    assert.equal(mouse.event, "native")
    assert.equal(mouse.position, undefined)
})

// ------------------------------------------------------------ complexity

// The previous implementation, which scanned the following candidates of a
// representative: the reference for the semantics. steps counts the
// candidates it looked at.
function referenceGroups(
    items: DuplicateCandidate[],
    identity: (i: DuplicateCandidate) => any = identityOf,
    counter = { steps: 0 }
) {
    const buckets = new Map<
        string,
        { id: number; source: number; time: number }[]
    >()
    const seen = new Set<number>()
    for (const item of items) {
        if (!item || seen.has(item._id)) continue
        seen.add(item._id)
        const id = identity(item)
        if (id === null) continue
        const entry = { id: item._id, source: item.source, time: id.time }
        const bucket = buckets.get(id.key)
        if (bucket) bucket.push(entry)
        else buckets.set(id.key, [entry])
    }
    const members = new Map<number, number[]>()
    const representativeOf = new Map<number, number>()
    for (const bucket of buckets.values()) {
        if (bucket.length < 2) continue
        bucket.sort((a, b) => b.time - a.time || b.id - a.id)
        const grouped = new Array<boolean>(bucket.length).fill(false)
        for (let i = 0; i < bucket.length; i++) {
            if (grouped[i]) continue
            const rep = bucket[i]
            const ids = [rep.id]
            const sources = new Set([rep.source])
            for (let j = i + 1; j < bucket.length; j++) {
                counter.steps++
                const other = bucket[j]
                if (rep.time - other.time > MAX_DATE_DIFFERENCE_MS) break
                if (grouped[j] || sources.has(other.source)) continue
                grouped[j] = true
                sources.add(other.source)
                ids.push(other.id)
            }
            if (ids.length < 2) continue
            members.set(rep.id, ids)
            for (const id of ids) representativeOf.set(id, rep.id)
        }
    }
    return { members, representativeOf }
}

const sortedEntries = (m: Map<number, any>) =>
    [...m.entries()].sort((a, b) => a[0] - b[0])

function sameResult(a: DuplicateGroups, b: DuplicateGroups, label: string) {
    assert.deepEqual(sortedEntries(a.members), sortedEntries(b.members), label)
    assert.deepEqual(
        sortedEntries(a.representativeOf),
        sortedEntries(b.representativeOf),
        label
    )
}

// Every invariant of a grouping.
function checkInvariants(
    items: DuplicateCandidate[],
    result: DuplicateGroups,
    timeOfItem: (i: DuplicateCandidate) => number
) {
    const byId = new Map(items.map(i => [i._id, i]))
    let grouped = 0
    for (const [rep, ids] of result.members) {
        assert.equal(ids[0], rep)
        assert.ok(ids.length >= 2)
        grouped += ids.length
        const sources = new Set(ids.map(id => byId.get(id).source))
        assert.equal(sources.size, ids.length, "one copy per source")
        const repTime = timeOfItem(byId.get(rep))
        for (let x = 1; x < ids.length; x++) {
            const prev = byId.get(ids[x - 1])
            const cur = byId.get(ids[x])
            const pt = timeOfItem(prev)
            const ct = timeOfItem(cur)
            assert.ok(
                pt > ct || (pt === ct && prev._id > cur._id),
                "feed order"
            )
            assert.ok(repTime - ct <= MAX_DATE_DIFFERENCE_MS, "window")
        }
        for (const id of ids) assert.equal(result.representativeOf.get(id), rep)
    }
    assert.equal(result.representativeOf.size, grouped)
}

// A deterministic generator (mulberry32).
function rng(seed: number) {
    let s = seed >>> 0
    return (n: number) => {
        s = (s + 0x6d2b79f5) >>> 0
        let t = s
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n) | 0
    }
}

test("equivalence with the previous algorithm on random inputs", () => {
    const rand = rng(20261121)
    let groups = 0
    for (let c = 0; c < 4000; c++) {
        const size = 1 + rand(40)
        const sources = 1 + rand(6)
        const keys = 1 + rand(3)
        const ids = shuffled(
            Array.from({ length: size }, (_, i) => i + 1),
            c + 1
        )
        const items = ids.map(id => {
            const k = rand(keys)
            // Steps of 5 minutes, sometimes 1 ms off: exact window edges,
            // ties, chains and gaps.
            const time = T0 - rand(6) * 5 * MINUTE - (rand(4) === 0 ? 1 : 0)
            return { ...copy(k, rand(sources), time), _id: id } as any
        })
        // Some articles are not eligible.
        if (size > 3) items[rand(size)].snippet = "breve"
        const result = groupDuplicates(items)
        sameResult(result, referenceGroups(items), `case ${c}`)
        checkInvariants(items, result, i => (i.date as Date).getTime())
        groups += result.members.size
        // Input order does not matter.
        sameResult(
            groupDuplicates(shuffled(items, c + 7)),
            result,
            `order ${c}`
        )
    }
    assert.ok(groups > 1000, `${groups} groups`)
})

// Articles of one identity, the date as milliseconds.
type Shape = (i: number, k: number) => { source: number; time: number }
const SHAPES: [string, Shape][] = [
    ["two sources in one window", i => ({ source: i % 2, time: T0 - i })],
    ["one source", i => ({ source: 0, time: T0 - i })],
    ["a source each, one window", i => ({ source: i, time: T0 - i })],
    [
        "a source each, a second apart",
        i => ({ source: i, time: T0 - i * SECOND }),
    ],
    [
        "skewed: one source holds 90%",
        i => ({
            source: i % 10 === 0 ? 1 + ((i / 10) % 10) : 0,
            time: T0 - i * 30,
        }),
    ],
    ["beyond the window", i => ({ source: i % 3, time: T0 - i * 11 * MINUTE })],
    ["same date and title, five sources", i => ({ source: i % 5, time: T0 })],
]

test("complexity: O(k log k) on every shape, same groups as before", () => {
    const identity = (i: any) => ({ key: "same", time: i.date })
    const time = (i: any) => i.date as number
    const rows: string[] = []
    const comparisons: { [shape: string]: number[] } = {}
    for (const [name, shape] of SHAPES) {
        comparisons[name] = []
        for (const k of [5000, 10000, 20000]) {
            const items = Array.from({ length: k }, (_, i) => {
                const { source, time } = shape(i, k)
                return { _id: i + 1, source, date: time } as any
            })
            const input = shuffled(items, k)
            const stats = { comparisons: 0 }
            let start = performance.now()
            const result = groupDuplicates(input, identity, stats)
            const after = performance.now() - start
            const counter = { steps: 0 }
            start = performance.now()
            const reference = referenceGroups(input, identity, counter)
            const before = performance.now() - start
            sameResult(result, reference, `${name} ${k}`)
            checkInvariants(items, result, time)
            const bound = 4 * k * Math.ceil(Math.log2(k))
            assert.ok(
                stats.comparisons <= bound,
                `${name} ${k}: ${stats.comparisons} > ${bound}`
            )
            comparisons[name].push(stats.comparisons)
            rows.push(
                `# ${name.padEnd(36)} k=${String(k).padStart(
                    5
                )}  before ${before.toFixed(1).padStart(7)} ms ${String(
                    counter.steps
                ).padStart(10)} steps | after ${after
                    .toFixed(1)
                    .padStart(6)} ms ${String(stats.comparisons).padStart(
                    8
                )} comparisons, ${result.members.size} groups`
            )
            assert.ok(after < 2000, `${name} ${k}: ${after} ms`)
        }
        // Doubling k little more than doubles the work (k log k: ~2.15).
        const [, c10, c20] = comparisons[name]
        assert.ok(c20 / c10 < 2.4, `${name}: ${c20} / ${c10}`)
    }
    for (const row of rows) console.log(row)
})

test("identity requires every field to be valid", () => {
    const base = {
        _id: 1,
        source: 0,
        title: title(1),
        snippet: snippet(1),
        link: "https://www.ansa.it/lombardia/notizie/x.html",
        date: new Date(T0),
    }
    assert.ok(identityOf(base))
    for (const [field, value] of [
        ["_id", 0],
        ["_id", 1.5],
        ["_id", "1"],
        ["source", NaN],
        ["source", "0"],
        ["date", new Date(NaN)],
        ["date", "yesterday"],
        ["date", null],
        ["title", ""],
        ["title", "   "],
        ["title", undefined],
        ["snippet", "Troppo breve per contare."],
        ["snippet", "x".repeat(200)],
        ["snippet", title(1)],
        ["link", "https://www.ansa.it/"],
        [
            "guid",
            "urn:fluent-reader:camera-deputati:odg:legislatura-19:seduta-1",
        ],
    ] as const) {
        assert.equal(
            identityOf({ ...base, [field]: value } as any),
            null,
            `${field}=${String(value)}`
        )
    }
    assert.equal(identityOf(null), null)
    // Different GUIDs and links do not matter; equal ones are no evidence.
    const a = { ...base, guid: "a" }
    const b = {
        ...base,
        _id: 2,
        source: 1,
        guid: "b",
        link: "https://ansa.it/veneto/y.html",
    }
    assert.ok(isSameArticle(a, b))
    const c = { ...b, snippet: snippet(2), link: a.link, guid: "a" }
    assert.ok(!isSameArticle(a, c))
    // Repeated ids are counted once.
    assert.deepEqual(groupDuplicates([a, a, b]).members.get(2), [2, 1])
})

test("performance: large loaded feeds", () => {
    const items: any = {}
    const iids: number[] = []
    const N = 20000
    let id = N
    for (let k = 0; id > 0; k++) {
        const t = T0 - k * 15 * MINUTE
        // One story in three has three copies, one in three two.
        const copies = k % 3 === 0 ? 3 : k % 3 === 1 ? 2 : 1
        for (let s = 0; s < copies && id > 0; s++) {
            const item = copy(k, s, t - s * SECOND)
            item._id = id--
            items[item._id] = item
            iids.push(item._id)
        }
    }
    const feed = new RSSFeed(
        ALL,
        [0, 1, 2, 3],
        new FeedFilter(FilterType.Default)
    )
    feed.iids = iids
    feed.loaded = true
    let start = performance.now()
    const view = computeFeedView(feed, items)
    const first = performance.now() - start
    checkView(feed, view)
    assert.ok(view.visible.length < N / 1.5)
    // A read state changes one article: identities of the others are reused.
    const next = { ...items, [iids[10]]: { ...items[iids[10]], hasRead: true } }
    start = performance.now()
    const again = computeFeedView(feed, next)
    const second = performance.now() - start
    assert.deepEqual(again.visible, view.visible)
    console.log(
        `# ${N} articles, ${view.visible.length} entries: ${first.toFixed(
            1
        )} ms, again ${second.toFixed(1)} ms`
    )
    assert.ok(first < 3000, `first ${first} ms`)
    assert.ok(second < 1000, `again ${second} ms`)
})

// ------------------------------------------------------------ feeds

test("pagination: feed.iids keeps every record; groups complete across pages", async () => {
    const store = await freshStore()
    const dispatch = store.dispatch as any
    await insertItems(scenario())
    const order = sqlOrder()
    assert.equal(order.length, 81)
    executed.length = 0
    await dispatch(initFeeds())
    let state = store.getState()
    let feed = state.feeds[ALL]
    assert.deepEqual(feed.iids, order.slice(0, 50))
    assert.equal(feed.allLoaded, false)
    let view = selectFeedView(state, ALL)
    checkView(feed, view)
    assert.equal(view.visible.length, 25)
    // Story 24 has two copies on the first page and one on the second.
    const first24 = storyIds(state, 24)
    assert.equal(first24.length, 2)
    assert.deepEqual(view.groups.get(first24[0]), first24)
    assert.ok(view.incomplete.has(first24[0]))
    // Groups well inside the page are complete.
    assert.ok(!view.incomplete.has(storyIds(state, 0)[0]))
    const before = new Map(view.groups)
    for (const k of [0, 3, 21])
        assert.equal(view.groups.get(storyIds(state, k)[0]).length, 3)
    for (const k of [1, 4, 22])
        assert.equal(view.groups.get(storyIds(state, k)[0]).length, 2)
    for (const k of [2, 5, 23])
        assert.ok(!view.representativeOf.has(storyIds(state, k)[0]))

    await dispatch(loadMore(store.getState().feeds[ALL]))
    state = store.getState()
    feed = state.feeds[ALL]
    // The offset counts records, not entries: nothing skipped or repeated.
    assert.deepEqual(feed.iids, order)
    assert.equal(new Set(feed.iids).size, 81)
    assert.equal(feed.allLoaded, true)
    view = selectFeedView(state, ALL)
    checkView(feed, view)
    assert.equal(view.visible.length, 40)
    const all24 = storyIds(state, 24)
    assert.equal(all24.length, 3)
    assert.deepEqual(view.groups.get(all24[0]), all24)
    assert.equal(all24[0], first24[0], "the representative did not change")
    assert.equal(view.incomplete.size, 0)
    // Loading older articles only completes groups.
    for (const [rep, ids] of before) {
        if (rep === first24[0]) continue
        assert.deepEqual(view.groups.get(rep), ids)
    }
    // Loading and grouping only read the database.
    assert.ok(executed.length > 0)
    assert.deepEqual(executed.filter(isWrite), [])
    // Grouping alone issues no statement at all.
    executed.length = 0
    computeFeedView(feed, state.items)
    selectFeedView(state, ALL)
    assert.equal(executed.length, 0)
})

test("pages made only of copies: loading and navigation go on", async () => {
    const store = await freshStore()
    const dispatch = store.dispatch as any
    const items: RSSItem[] = []
    // 100 stories one second apart in source 0, the same 100 nine minutes
    // later in source 1: pages 3 and 4 hold only copies of shown entries.
    for (let k = 0; k < 100; k++) {
        items.push(copy(k, 0, T0 - k * SECOND))
        items.push(copy(k, 1, T0 - 9 * MINUTE - k * SECOND))
    }
    items.push(copy(500, 3, T0 - 30 * MINUTE))
    await insertItems(items)
    await dispatch(initFeeds())
    await dispatch(loadMore(store.getState().feeds[ALL]))
    let state = store.getState()
    let view = selectFeedView(state, ALL)
    assert.equal(state.feeds[ALL].iids.length, 100)
    assert.equal(view.visible.length, 100)
    // Every group may still gain its copy in source 1.
    assert.equal(view.groups.size, 0)
    const last = view.visible[99]
    dispatch(showItem(ALL, state.items[last]))
    assert.ok(canShowOffsetItem(store.getState(), 1))
    // showOffsetItem does not wait for the attempts after the first page.
    await dispatch(showOffsetItem(1))
    await flush()
    state = store.getState()
    view = selectFeedView(state, ALL)
    const feed = state.feeds[ALL]
    // Three more pages were loaded: two of copies, then the Il Post article.
    assert.equal(feed.iids.length, 201)
    assert.equal(view.visible.length, 101)
    assert.equal(view.groups.size, 100)
    checkView(feed, view)
    assert.equal(state.items[state.page.itemId].title, title(500))
    assert.equal(state.page.itemId, view.visible[100])
    assert.ok(!canShowOffsetItem(state, 1))
})

test("new and updated articles: groups follow, without a second entry", async () => {
    const store = await freshStore()
    const dispatch = store.dispatch as any
    await insertItems(scenario())
    await dispatch(initFeeds())
    await dispatch(loadMore(store.getState().feeds[ALL]))
    let state = store.getState()
    const ids1 = storyIds(state, 1)
    // A newer copy of story 1 arrives from a third source.
    const [inserted] = await insertItems([
        copy(1, 2, T0 - 20 * MINUTE + MINUTE),
    ])
    dispatch(fetchItemsSuccess([inserted], store.getState().items))
    state = store.getState()
    let view = selectFeedView(state, ALL)
    assert.equal(state.feeds[ALL].iids.length, 82)
    assert.equal(view.visible.length, 40)
    assert.deepEqual(view.groups.get(inserted._id), [inserted._id, ...ids1])
    assert.ok(!view.visible.includes(ids1[0]))
    checkView(state.feeds[ALL], view)

    // A copy of story 3 changes text in place: it leaves the group.
    const ids3 = storyIds(state, 3)
    const changed = ids3[1]
    sqlite
        .prepare("UPDATE items SET snippet = ?, hasRead = 1 WHERE _id = ?")
        .run(snippet(9999), changed)
    const read = sqlite.prepare("SELECT * FROM items WHERE _id = ?")
    const asItem = (r: any) => ({
        ...r,
        date: new Date(r.date),
        fetchedDate: new Date(r.fetchedDate),
        hasRead: Boolean(r.hasRead),
        starred: Boolean(r.starred),
        hidden: Boolean(r.hidden),
        notify: Boolean(r.notify),
    })
    dispatch(updateItemContent([asItem(read.get(changed))]))
    state = store.getState()
    view = selectFeedView(state, ALL)
    assert.equal(view.visible.length, 41)
    assert.ok(view.visible.includes(changed))
    assert.deepEqual(view.groups.get(ids3[0]), [ids3[0], ids3[2]])
    // In-place updates keep the state in memory, not the row's.
    assert.equal(state.items[changed].hasRead, false)
    assert.equal(state.feeds[ALL].iids.length, 82)
    // Back to the same text: it rejoins.
    sqlite
        .prepare("UPDATE items SET snippet = ? WHERE _id = ?")
        .run(snippet(3), changed)
    dispatch(updateItemContent([asItem(read.get(changed))]))
    view = selectFeedView(store.getState(), ALL)
    assert.deepEqual(view.groups.get(ids3[0]), ids3)
    assert.equal(view.visible.length, 40)
})

test("read, starred and hidden states stay per article", async () => {
    const store = await freshStore()
    const dispatch = store.dispatch as any
    await insertItems(scenario())
    await dispatch(initFeeds())
    let state = store.getState()
    const [rep, second, third] = storyIds(state, 0)
    const actions = {
        markRead: (i: RSSItem) => dispatch(markRead(i)),
        showItem: (f: string, i: RSSItem) => dispatch(showItem(f, i)),
    }
    executed.length = 0
    // Opening the shown copy, as clicking its card does.
    Card.openArticle(
        actions,
        ALL,
        state.items[rep],
        state.sources[0],
        undefined
    )
    await flush()
    state = store.getState()
    assert.equal(state.page.itemId, rep)
    assert.deepEqual(
        [rep, second, third].map(id => Boolean(row(id).hasRead)),
        [true, false, false]
    )
    assert.deepEqual(
        [rep, second, third].map(id => state.items[id].hasRead),
        [true, false, false]
    )
    const writes = executed.filter(isWrite)
    assert.equal(writes.length, 1)
    assert.match(
        writes[0],
        /^update "items" set "hasRead" = \? where "items"\."_id" = \?$/
    )
    await dispatch(toggleStarred(store.getState().items[third]))
    state = store.getState()
    assert.deepEqual(
        [rep, second, third].map(id => Boolean(row(id).starred)),
        [false, false, true]
    )
    assert.deepEqual(
        [rep, second, third].map(id => state.items[id].starred),
        [false, false, true]
    )
    // The group is unchanged by states.
    assert.deepEqual(selectFeedView(state, ALL).groups.get(rep), [
        rep,
        second,
        third,
    ])
    // markAllRead still marks every article of the given sources.
    await dispatch(markAllRead([1]))
    state = store.getState()
    assert.equal(Boolean(row(second).hasRead), true)
    assert.equal(Boolean(row(third).hasRead), false)
    const source1 = sqlite
        .prepare(
            "SELECT COUNT(*) AS n FROM items WHERE source = 1 AND hasRead = 0"
        )
        .get() as any
    assert.equal(source1.n, 0)
})

test("filters apply to articles before grouping; hidden copies never join", async () => {
    const store = await freshStore()
    const dispatch = store.dispatch as any
    await insertItems(scenario())
    await dispatch(initFeeds())
    let state = store.getState()
    const [rep, second, third] = storyIds(state, 0)
    // The newest copy was read: only the unread ones are listed and grouped.
    sqlite.prepare("UPDATE items SET hasRead = 1 WHERE _id = ?").run(rep)
    dispatch(switchFilter(FilterType.UnreadOnly))
    await flush()
    state = store.getState()
    let view = selectFeedView(state, ALL)
    assert.ok(!state.feeds[ALL].iids.includes(rep))
    assert.deepEqual(view.groups.get(second), [second, third])
    checkView(state.feeds[ALL], view)
    // Starred only: a single starred copy is shown alone.
    sqlite.prepare("UPDATE items SET starred = 1 WHERE _id = ?").run(third)
    dispatch(switchFilter(FilterType.StarredOnly))
    await flush()
    state = store.getState()
    view = selectFeedView(state, ALL)
    assert.deepEqual(state.feeds[ALL].iids, [third])
    assert.deepEqual(view.visible, [third])
    assert.equal(view.groups.size, 0)
    // Back to all articles; hiding a copy takes it out of its group.
    dispatch(switchFilter(FilterType.Default))
    await flush()
    state = store.getState()
    await dispatch(toggleHidden(state.items[second]))
    state = store.getState()
    view = selectFeedView(state, ALL)
    assert.ok(!state.feeds[ALL].iids.includes(second))
    assert.deepEqual(view.groups.get(rep), [rep, third])
    // Showing hidden articles lists it, and its group, again.
    dispatch(toggleFilter(FilterType.ShowHidden))
    await flush()
    state = store.getState()
    view = selectFeedView(state, ALL)
    assert.deepEqual(view.groups.get(rep), [rep, second, third])
    // A hidden article listed in a feed that does not show hidden ones (e.g.
    // still open) stays its own entry and does not pull in the others.
    const feed = {
        ...state.feeds[ALL],
        filter: new FeedFilter(FilterType.Default),
    }
    const items = {
        ...state.items,
        [rep]: { ...state.items[rep], hidden: true },
        [second]: { ...state.items[second], hidden: false },
    }
    view = computeFeedView(feed, items)
    assert.ok(view.visible.includes(rep))
    assert.ok(!view.representativeOf.has(rep))
    assert.deepEqual(view.groups.get(second), [second, third])
})

test("navigation moves between entries, from any copy", async () => {
    const store = await freshStore()
    const dispatch = store.dispatch as any
    await insertItems(scenario())
    await dispatch(initFeeds())
    let state = store.getState()
    const view = selectFeedView(state, ALL)
    const entry = (k: number) => storyIds(state, k)[0]
    assert.deepEqual(view.visible.slice(0, 5), [0, 1, 2, 3, 4].map(entry))
    dispatch(showItem(ALL, state.items[entry(0)]))
    assert.ok(!canShowOffsetItem(store.getState(), -1))
    await dispatch(showOffsetItem(1))
    assert.equal(store.getState().page.itemId, entry(1))
    // Open a copy that is not shown, e.g. from the list of copies.
    const hiddenCopy = storyIds(state, 3)[2]
    dispatch(showItem(ALL, state.items[hiddenCopy]))
    await dispatch(showOffsetItem(1))
    assert.equal(store.getState().page.itemId, entry(4))
    dispatch(showItem(ALL, state.items[hiddenCopy]))
    await dispatch(showOffsetItem(-1))
    assert.equal(store.getState().page.itemId, entry(2))
    // Only the articles navigated to were read.
    state = store.getState()
    for (const id of storyIds(state, 3))
        assert.equal(state.items[id].hasRead, false)
    // Next from the last entry of the page loads the next page.
    dispatch(showItem(ALL, state.items[view.visible[24]]))
    assert.ok(canShowOffsetItem(store.getState(), 1))
    await dispatch(showOffsetItem(1))
    state = store.getState()
    assert.equal(state.feeds[ALL].iids.length, 81)
    assert.equal(state.page.itemId, storyIds(state, 25)[0])
})

test("copies menu: each copy opens on its own, as its source is set", async () => {
    const store = await freshStore()
    const dispatch = store.dispatch as any
    await insertItems(scenario())
    await dispatch(initFeeds())
    let state = store.getState()
    const ids = storyIds(state, 0)
    const sources = { ...state.sources }
    sources[2] = { ...sources[2], openTarget: SourceOpenTarget.External }
    const duplicates: Card.Duplicates = {
        copies: ids.map(id => ({
            item: state.items[id],
            source: sources[state.items[id].source],
        })),
        incomplete: true,
    }
    const opened: string[] = []
    const g = globalThis as any
    g.utils.openExternal = (url: string) => opened.push(url)
    const open = (c: Card.Copy, e: any) =>
        Card.openArticle(
            {
                markRead: i => dispatch(markRead(i)),
                showItem: (f, i) => dispatch(showItem(f, i)),
            },
            ALL,
            c.item,
            c.source,
            e
        )
    const entries = duplicateMenuItems(duplicates, ids[1], open)
    // Header, one entry per copy, and a note that the list may grow.
    assert.equal(entries.length, ids.length + 2)
    const copies = entries.slice(1, 1 + ids.length)
    assert.deepEqual(
        copies.map(e => e.key),
        ids.map(String)
    )
    assert.deepEqual(
        copies.map(e => e.text),
        ["ANSA Lombardia", "ANSA Veneto", "ANSA Emilia-Romagna"]
    )
    assert.deepEqual(
        copies.map(e => e.checked),
        [false, true, false]
    )
    assert.equal(entries[entries.length - 1].disabled, true)
    copies[1].onClick({ ctrlKey: false, metaKey: false } as any)
    await flush()
    state = store.getState()
    assert.equal(state.page.itemId, ids[1])
    assert.deepEqual(
        ids.map(id => state.items[id].hasRead),
        [false, true, false]
    )
    // A copy whose source opens externally goes to the browser.
    copies[2].onClick({ ctrlKey: false, metaKey: false } as any)
    await flush()
    state = store.getState()
    assert.deepEqual(opened, [state.items[ids[2]].link])
    assert.equal(state.page.itemId, ids[1])
    assert.deepEqual(
        ids.map(id => state.items[id].hasRead),
        [false, true, true]
    )
    // A complete list has no note.
    assert.equal(
        duplicateMenuItems({ ...duplicates, incomplete: false }, null, open)
            .length,
        ids.length + 1
    )
})

test("scope: single source views are not grouped; source changes regroup", async () => {
    const store = await freshStore()
    const dispatch = store.dispatch as any
    await insertItems(scenario())
    await dispatch(initFeeds())
    // The view of one source.
    dispatch(selectSources([0], "s-0", "ANSA Lombardia"))
    await dispatch(initFeeds())
    let state = store.getState()
    let view = selectFeedView(state, SOURCE)
    assert.equal(state.feeds[SOURCE].loaded, true)
    assert.equal(view.visible, state.feeds[SOURCE].iids)
    assert.equal(view.groups.size, 0)
    // A group of two sources.
    dispatch(selectSources([0, 1], "g-0", "ANSA"))
    await dispatch(initFeeds())
    state = store.getState()
    view = selectFeedView(state, SOURCE)
    const story0 = storyIds(state, 0).filter(id => state.items[id].source !== 2)
    assert.deepEqual(view.groups.get(story0[0]), story0)
    checkView(state.feeds[SOURCE], view)
    // Hiding a source rebuilds the feeds without it.
    dispatch({
        type: HIDE_SOURCE,
        status: ActionStatus.Success,
        source: state.sources[1],
    })
    await dispatch(initFeeds())
    state = store.getState()
    view = selectFeedView(state, ALL)
    const without1 = storyIds(state, 0).filter(
        id => state.items[id].source !== 1
    )
    assert.deepEqual(view.groups.get(without1[0]), without1)
    assert.ok(!state.feeds[ALL].iids.some(id => state.items[id].source === 1))
    checkView(state.feeds[ALL], view)
    dispatch({
        type: UNHIDE_SOURCE,
        status: ActionStatus.Success,
        source: state.sources[1],
    })
    await dispatch(initFeeds())
    state = store.getState()
    view = selectFeedView(state, ALL)
    assert.deepEqual(view.groups.get(storyIds(state, 0)[0]), storyIds(state, 0))
})
