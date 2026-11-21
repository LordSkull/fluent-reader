// Grouping of the same article published by several RSS sources, as a pure
// presentation step. Nothing here reads or writes the database, Redux or the
// DOM: articles keep their own rows, ids and states, and a group is only a
// representative article plus the ids of its copies.
//
// The exact rules, for other clients, are published in
// contracts/cross-source-duplicates (README.md and conformance.json).
//
// Identity criterion (version 1). Two articles are copies of each other only
// when ALL of these hold:
//   1. they belong to different sources;
//   2. both links are absolute http(s) URLs of the same publisher host, after
//      lowercasing and removing one leading "www." and a trailing dot (no
//      public-suffix reduction: "lombardia.ansa.it" is not "www.ansa.it"),
//      and neither link is a generic page (site root or index page);
//   3. their titles are equal after normalizeText(), and not empty;
//   4. their snippets are equal after normalizeText(), contain at least
//      MIN_SNIPPET_LENGTH characters and MIN_SNIPPET_WORDS words, and differ
//      from the title;
//   5. their publication dates differ by at most MAX_DATE_DIFFERENCE_MS;
//   6. ids, sources and dates are valid (timeOf: a Date, integer milliseconds
//      or a strict ISO 8601 string), and neither article was synthesized
//      by a Fluent Reader feed normalizer (GUID starting with
//      SYNTHETIC_GUID_PREFIX, e.g. the Camera dei deputati agenda).
// GUIDs and URLs are never compared: different values do not prevent a group,
// equal values are not evidence. There is no fuzzy or semantic matching.
//
// Grouping. Copies are only looked for among articles with the same
// identity key (publisher, title, snippet). Within a key, articles are taken
// newest first (then by descending id, as feeds are ordered); the first one
// not yet grouped becomes a representative, and each later article joins it
// if it is from a source not yet in the group and is at most
// MAX_DATE_DIFFERENCE_MS older than the representative. A group therefore
// spans at most that interval: the relation is never applied transitively.
// Articles older than every article already considered never change the
// groups of those articles, so loading more pages only completes groups.

export const MAX_DATE_DIFFERENCE_MS = 10 * 60 * 1000
export const MIN_SNIPPET_LENGTH = 60
export const MIN_SNIPPET_WORDS = 8
export const SYNTHETIC_GUID_PREFIX = "urn:fluent-reader:"
// Paths that identify a site rather than an article, after removing trailing
// slashes and lowercasing. The root path is always generic.
export const GENERIC_PATHS: readonly string[] = [
    "",
    "/index",
    "/index.htm",
    "/index.html",
    "/index.php",
    "/index.asp",
    "/index.aspx",
    "/default.asp",
    "/default.aspx",
    "/home",
    "/home.html",
    "/home.php",
]

// The fields used, as stored for an article. Values of the wrong type make
// an article ineligible rather than failing.
export type DuplicateCandidate = {
    _id: number
    source: number
    title: unknown
    snippet: unknown
    link: unknown
    date: unknown
    guid?: unknown
}

// The named character references decoded, and nothing else. Part of the
// published contract (contracts/cross-source-duplicates).
export const NAMED_ENTITIES: Readonly<{ [name: string]: string }> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00a0",
    shy: "\u00ad",
    laquo: "«",
    raquo: "»",
    lsaquo: "‹",
    rsaquo: "›",
    lsquo: "‘",
    rsquo: "’",
    sbquo: "‚",
    ldquo: "“",
    rdquo: "”",
    bdquo: "„",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    middot: "·",
    bull: "•",
    deg: "°",
    euro: "€",
    pound: "£",
    copy: "©",
    reg: "®",
    trade: "™",
    sect: "§",
    para: "¶",
    times: "×",
    divide: "÷",
    iexcl: "¡",
    iquest: "¿",
    ordf: "ª",
    ordm: "º",
    agrave: "à",
    aacute: "á",
    acirc: "â",
    atilde: "ã",
    auml: "ä",
    aring: "å",
    aelig: "æ",
    ccedil: "ç",
    egrave: "è",
    eacute: "é",
    ecirc: "ê",
    euml: "ë",
    igrave: "ì",
    iacute: "í",
    icirc: "î",
    iuml: "ï",
    ntilde: "ñ",
    ograve: "ò",
    oacute: "ó",
    ocirc: "ô",
    otilde: "õ",
    ouml: "ö",
    oslash: "ø",
    ugrave: "ù",
    uacute: "ú",
    ucirc: "û",
    uuml: "ü",
    yacute: "ý",
    yuml: "ÿ",
    szlig: "ß",
    Agrave: "À",
    Aacute: "Á",
    Acirc: "Â",
    Atilde: "Ã",
    Auml: "Ä",
    Aring: "Å",
    AElig: "Æ",
    Ccedil: "Ç",
    Egrave: "È",
    Eacute: "É",
    Ecirc: "Ê",
    Euml: "Ë",
    Igrave: "Ì",
    Iacute: "Í",
    Icirc: "Î",
    Iuml: "Ï",
    Ntilde: "Ñ",
    Ograve: "Ò",
    Oacute: "Ó",
    Ocirc: "Ô",
    Otilde: "Õ",
    Ouml: "Ö",
    Oslash: "Ø",
    Ugrave: "Ù",
    Uacute: "Ú",
    Ucirc: "Û",
    Uuml: "Ü",
    Yacute: "Ý",
}

// Decodes character references once: "&amp;lt;" becomes "&lt;". Unknown
// names and invalid code points are kept as written.
export function decodeEntities(text: string): string {
    return text.replace(
        /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/g,
        (match, hex: string, dec: string, name: string) => {
            if (name !== undefined)
                return Object.prototype.hasOwnProperty.call(
                    NAMED_ENTITIES,
                    name
                )
                    ? NAMED_ENTITIES[name]
                    : match
            const code = parseInt(hex ?? dec, hex !== undefined ? 16 : 10)
            if (
                code === 0 ||
                code > 0x10ffff ||
                (code >= 0xd800 && code <= 0xdfff)
            )
                return match
            return String.fromCodePoint(code)
        }
    )
}

// Characters without width that feeds insert inconsistently: soft hyphen,
// zero width space, non-joiner and joiner, word joiner, byte order mark.
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g
// White space: the characters of String.prototype.trim and \s, listed
// explicitly so that the set does not depend on the runtime.
const SPACES =
    /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g

// Entities decoded, NFKC, invisible characters removed, white space collapsed
// and trimmed, lowercase. Not a string: null.
export function normalizeText(value: unknown): string | null {
    if (typeof value !== "string") return null
    return decodeEntities(value)
        .normalize("NFKC")
        .replace(INVISIBLE, "")
        .replace(SPACES, " ")
        .replace(/^ | $/g, "")
        .toLowerCase()
}

// Length in Unicode code points, not UTF-16 units.
export function codePointLength(text: string): number {
    let length = 0
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i)
        length++
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = text.charCodeAt(i + 1)
            if (next >= 0xdc00 && next <= 0xdfff) i++
        }
    }
    return length
}

// Words: runs of letters and digits.
export function countWords(text: string): number {
    return (text.match(/[\p{L}\p{N}]+/gu) || []).length
}

// The publisher of an article link, or null when the link cannot identify
// one: not an absolute http(s) URL, with credentials, or a generic page.
export function publisherOf(link: unknown): string | null {
    if (typeof link !== "string") return null
    let url: URL
    try {
        url = new URL(link.trim())
    } catch {
        return null
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.username || url.password) return null
    let host = url.hostname.toLowerCase().replace(/\.$/, "")
    if (host.startsWith("www.")) host = host.slice(4)
    if (!host || !host.includes(".")) return null
    const path = url.pathname.replace(/\/+$/, "").toLowerCase()
    if (GENERIC_PATHS.includes(path) && !url.search) return null
    return url.port ? `${host}:${url.port}` : host
}

// The only accepted date strings: UTC or with an explicit offset, seconds
// required, at most three fraction digits.
const ISO_DATE =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/
// Dates representable by Date.
const MAX_TIME = 8.64e15

const isLeapYear = (y: number) =>
    (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const daysInMonth = (y: number, m: number) =>
    m === 2 ? (isLeapYear(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31

// Milliseconds of a date string in the format above, or null; computed
// without Date.parse, whose other formats depend on the runtime.
export function parseIsoDate(text: string): number | null {
    const m = ISO_DATE.exec(text)
    if (!m) return null
    const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number)
    const ms = m[7] ? Number(m[7].padEnd(3, "0")) : 0
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
        return null
    if (hour > 23 || minute > 59 || second > 59) return null
    let offset = 0
    if (m[8]) {
        const hours = Number(m[9])
        const minutes = Number(m[10])
        if (hours > 23 || minutes > 59) return null
        offset = (m[8] === "+" ? 1 : -1) * (hours * 60 + minutes) * 60000
    }
    // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999.
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hour, minute, second, ms)
    const time = date.getTime() - offset
    return Number.isFinite(time) && Math.abs(time) <= MAX_TIME ? time : null
}

// Milliseconds since the epoch of a valid Date, an integer number of
// milliseconds (as stored) or a date string in the format above.
export function timeOf(date: unknown): number | null {
    const time =
        date instanceof Date
            ? date.getTime()
            : typeof date === "number"
            ? date
            : typeof date === "string"
            ? parseIsoDate(date)
            : null
    return Number.isSafeInteger(time) && Math.abs(time) <= MAX_TIME
        ? time
        : null
}

// What an eligible article is compared by.
export type DuplicateIdentity = {
    key: string
    time: number
}

// The identity of an article, or null when it cannot be grouped.
export function identityOf(item: DuplicateCandidate): DuplicateIdentity | null {
    if (!item || !Number.isSafeInteger(item._id) || item._id <= 0) return null
    if (!Number.isSafeInteger(item.source)) return null
    if (
        typeof item.guid === "string" &&
        item.guid.startsWith(SYNTHETIC_GUID_PREFIX)
    )
        return null
    const time = timeOf(item.date)
    if (time === null) return null
    const publisher = publisherOf(item.link)
    if (publisher === null) return null
    const title = normalizeText(item.title)
    if (!title) return null
    const snippet = normalizeText(item.snippet)
    if (
        !snippet ||
        snippet === title ||
        codePointLength(snippet) < MIN_SNIPPET_LENGTH ||
        countWords(snippet) < MIN_SNIPPET_WORDS
    )
        return null
    return { key: `${publisher}\n${title}\n${snippet}`, time }
}

// Whether two articles are copies of each other (criterion above), regardless
// of how a list of articles is grouped.
export function isSameArticle(
    a: DuplicateCandidate,
    b: DuplicateCandidate
): boolean {
    if (!a || !b || a.source === b.source || a._id === b._id) return false
    const ia = identityOf(a)
    const ib = identityOf(b)
    return (
        ia !== null &&
        ib !== null &&
        ia.key === ib.key &&
        Math.abs(ia.time - ib.time) <= MAX_DATE_DIFFERENCE_MS
    )
}

export type DuplicateGroups = {
    // Representative id → ids of the group, representative first, then by
    // descending date and id. Only groups of two or more articles.
    members: Map<number, number[]>
    // Id of every grouped article → id of its representative.
    representativeOf: Map<number, number>
}

type Entry = { id: number; source: number; time: number }
// The candidates of one source within one identity, in feed order; next is
// the newest one not yet assigned.
type Queue = { entries: Entry[]; next: number }

// Newest first, then by descending id: the order of feeds.
const byFeedOrder = (a: Entry, b: Entry) => b.time - a.time || b.id - a.id

// Comparisons made, for tests of the complexity.
export type GroupingStats = { comparisons: number }

// A binary heap of queues, the one whose next candidate comes first in feed
// order on top. Each source is in it at most once.
class QueueHeap {
    private heap: Queue[] = []
    constructor(private stats: GroupingStats) {}
    get size() {
        return this.heap.length
    }
    peek(): Entry {
        const top = this.heap[0]
        return top.entries[top.next]
    }
    private before(a: Queue, b: Queue) {
        this.stats.comparisons++
        return byFeedOrder(a.entries[a.next], b.entries[b.next]) < 0
    }
    push(queue: Queue) {
        const heap = this.heap
        let i = heap.push(queue) - 1
        while (i > 0) {
            const parent = (i - 1) >> 1
            if (!this.before(heap[i], heap[parent])) break
            ;[heap[i], heap[parent]] = [heap[parent], heap[i]]
            i = parent
        }
    }
    pop(): Queue {
        const heap = this.heap
        const top = heap[0]
        const last = heap.pop()
        if (heap.length > 0) {
            heap[0] = last
            let i = 0
            for (;;) {
                const left = 2 * i + 1
                const right = left + 1
                let first = i
                if (left < heap.length && this.before(heap[left], heap[first]))
                    first = left
                if (
                    right < heap.length &&
                    this.before(heap[right], heap[first])
                )
                    first = right
                if (first === i) break
                ;[heap[i], heap[first]] = [heap[first], heap[i]]
                i = first
            }
        }
        return top
    }
}

// Groups copies among articles. The input order does not matter; articles
// without a valid identity, or with an id already seen, stay ungrouped.
// identity lets callers cache identityOf() per article.
//
// Within an identity the newest unassigned candidate is the representative;
// the group takes, from every other source, its newest unassigned candidate
// if that is at most MAX_DATE_DIFFERENCE_MS older than the representative.
// Only the newest unassigned candidate of each source is in the heap, so a
// group is built from the top of the heap without scanning other candidates:
// every candidate is pushed and popped once, O(k log k) for k candidates.
export function groupDuplicates(
    items: Iterable<DuplicateCandidate>,
    identity: (
        item: DuplicateCandidate
    ) => DuplicateIdentity | null = identityOf,
    stats: GroupingStats = { comparisons: 0 }
): DuplicateGroups {
    const buckets = new Map<string, Entry[]>()
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
    const compare = (a: Entry, b: Entry) => {
        stats.comparisons++
        return byFeedOrder(a, b)
    }
    for (const bucket of buckets.values()) {
        if (bucket.length < 2) continue
        bucket.sort(compare)
        const queues = new Map<number, Queue>()
        for (const entry of bucket) {
            const queue = queues.get(entry.source)
            if (queue) queue.entries.push(entry)
            else queues.set(entry.source, { entries: [entry], next: 0 })
        }
        // Copies need two sources.
        if (queues.size < 2) continue
        const heap = new QueueHeap(stats)
        for (const queue of queues.values()) heap.push(queue)
        while (heap.size > 0) {
            const taken = [heap.pop()]
            const rep = taken[0].entries[taken[0].next]
            while (
                heap.size > 0 &&
                rep.time - heap.peek().time <= MAX_DATE_DIFFERENCE_MS
            )
                taken.push(heap.pop())
            const ids = taken.map(queue => queue.entries[queue.next++].id)
            for (const queue of taken)
                if (queue.next < queue.entries.length) heap.push(queue)
            if (ids.length < 2) continue
            members.set(rep.id, ids)
            for (const id of ids) representativeOf.set(id, rep.id)
        }
    }
    return { members, representativeOf }
}
