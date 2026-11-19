// Merges the agenda of one sitting of the Italian Chamber of Deputies
// (Camera dei deputati) into a single article. The official feed publishes
// every agenda point, and the opening schedule line, as a separate item that
// links to the same page. Nothing is merged unless all of it is verified.
//
// - Only the feed at CAMERA_ODG_FEED_URL is merged, and only if it was also
//   served from there after redirects. The channel title must state the
//   legislature, the sitting and its date; the channel and every item must
//   link to the agenda page of that legislature (/leg19/187), and every item
//   needs a GUID and a publication date on the day of the sitting.
// - A response that fails these checks is "invalid". Until the source has a
//   merged article, its items are imported separately, as for any feed. Once
//   it has one, an invalid response is reported as a fetch error and nothing
//   is stored, so the last valid version stays and the next fetch retries.
//   A response without items stores nothing and is not an error.
// - The article's GUID depends only on the legislature and the sitting, so
//   later versions of the agenda update the same article in place (see
//   ../models/aggregate.ts), and every sitting gets its own article.
// - Sittings imported separately by older versions are not converted: while
//   any of their items is stored, the sitting stays separate and its new
//   items are still imported. Stored items are recognized as when importing
//   any feed: by GUID, or, for articles migrated without one, by title, link
//   and publication date. Existing articles are never merged, moved, hidden
//   or deleted. The first sitting not imported yet becomes one article.
import type { FeedInput, FeedItemInput, NormalizeResult } from "./types"

export const CAMERA_ODG_FEED_URL =
    "https://documenti.camera.it/apps/rssFeeds/odg/getFeed.asp"

const FEED_HOST = "documenti.camera.it"
const FEED_PATH = "/apps/rssfeeds/odg/getfeed.asp"
const PAGE_HOST = "www.camera.it"
// Shared by the GUIDs of all the articles built from this feed.
export const CAMERA_ODG_GUID_PREFIX = "urn:fluent-reader:camera-deputati:odg:"

const CHANNEL_TITLE_RE =
    /^Camera dei deputati, ordine del giorno dell['’]Assemblea, Legislatura ([1-9]\d{0,2}), Seduta n\. ([1-9]\d{0,4}) del (\d{2})\/(\d{2})\/(\d{4})$/

// RFC 822 dates as the Camera writes them, with Italian or English names:
// "gio, 19 nov 2026 00:00:00 +0100". The weekday is not checked.
const PUB_DATE_RE =
    /^(?:[a-z]{2,4}\.?,\s*)?(\d{1,2})\s+([a-z]{3})\.?\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(?:([+-])(\d{2})(\d{2})|gmt|utc?|z)$/i

const MONTHS: { [abbr: string]: number } = {
    gen: 1,
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    mag: 5,
    may: 5,
    giu: 6,
    jun: 6,
    lug: 7,
    jul: 7,
    ago: 8,
    aug: 8,
    set: 9,
    sep: 9,
    ott: 10,
    oct: 10,
    nov: 11,
    dic: 12,
    dec: 12,
}

const MONTH_NAMES = [
    "gennaio",
    "febbraio",
    "marzo",
    "aprile",
    "maggio",
    "giugno",
    "luglio",
    "agosto",
    "settembre",
    "ottobre",
    "novembre",
    "dicembre",
]

type CalendarDate = { year: number; month: number; day: number }

function isCalendarDate(year: number, month: number, day: number) {
    const date = new Date(Date.UTC(year, month - 1, day))
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    )
}

function parseUrl(value: unknown): URL | null {
    if (typeof value !== "string") return null
    try {
        return new URL(value.trim())
    } catch {
        return null
    }
}

// Matches the Camera feed exactly, apart from the letter case of the path,
// which the Camera's server ignores. The final URL of a response must be
// HTTPS; a subscription may still use plain HTTP.
export function isCameraOdgFeedUrl(value: unknown, httpsOnly = false) {
    const url = parseUrl(value)
    return (
        url !== null &&
        (url.protocol === "https:" ||
            (!httpsOnly && url.protocol === "http:")) &&
        url.username === "" &&
        url.password === "" &&
        url.hostname === FEED_HOST &&
        url.port === "" &&
        url.pathname.toLowerCase() === FEED_PATH &&
        url.search === "" &&
        url.hash === ""
    )
}

function oneLine(value: unknown) {
    return typeof value === "string" ? value.replace(/[\s ]+/g, " ").trim() : ""
}

export function parseChannelTitle(title: unknown) {
    const match = CHANNEL_TITLE_RE.exec(oneLine(title))
    if (!match) return null
    const [legislatura, seduta, day, month, year] = match
        .slice(1)
        .map(n => parseInt(n, 10))
    if (!isCalendarDate(year, month, day)) return null
    return { legislatura, seduta, date: { year, month, day } }
}

// Returns the calendar date as written and the instant it denotes.
export function parsePubDate(value: unknown) {
    const match = PUB_DATE_RE.exec(oneLine(value))
    if (!match) return null
    const month = MONTHS[match[2].toLowerCase()]
    const [day, year, hours, minutes] = [1, 3, 4, 5].map(i =>
        parseInt(match[i], 10)
    )
    const seconds = match[6] ? parseInt(match[6], 10) : 0
    if (!month || !isCalendarDate(year, month, day)) return null
    if (hours > 23 || minutes > 59 || seconds > 59) return null
    let offset = 0
    if (match[7]) {
        const offsetHours = parseInt(match[8], 10)
        const offsetMinutes = parseInt(match[9], 10)
        if (offsetHours > 14 || offsetMinutes > 59) return null
        offset =
            (match[7] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes)
    }
    const instant = new Date(
        Date.UTC(year, month - 1, day, hours, minutes, seconds) - offset * 60000
    )
    return { date: { year, month, day } as CalendarDate, instant }
}

// The page of the agenda of the Assembly on the Camera's website, for the
// legislature of the sitting: https://www.camera.it/leg19/187. No other page,
// query or fragment is accepted.
export function parsePageLink(value: unknown, legislatura: number) {
    const url = parseUrl(value)
    if (
        url === null ||
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.hostname !== PAGE_HOST ||
        url.port !== "" ||
        url.pathname !== `/leg${legislatura}/187` ||
        url.search !== "" ||
        url.hash !== ""
    )
        return null
    return url.href
}

const ENTITIES: { [name: string]: string } = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    agrave: "à",
    egrave: "è",
    eacute: "é",
    igrave: "ì",
    ograve: "ò",
    ugrave: "ù",
    Agrave: "À",
    Egrave: "È",
    Eacute: "É",
    Igrave: "Ì",
    Ograve: "Ò",
    Ugrave: "Ù",
    laquo: "«",
    raquo: "»",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    deg: "°",
    euro: "€",
}

function decodeEntities(text: string) {
    return text.replace(
        /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi,
        (entity, dec: string, hex: string, name: string) => {
            if (name) return ENTITIES[name] ?? entity
            const code = dec ? parseInt(dec, 10) : parseInt(hex, 16)
            const valid =
                code > 0 &&
                code <= 0x10ffff &&
                !(code >= 0xd800 && code <= 0xdfff)
            return valid ? String.fromCodePoint(code) : entity
        }
    )
}

// Descriptions are HTML: the Camera separates their lines with <br/>, and
// sometimes with plain line breaks only. Lines are kept in order as text.
// Other tags are dropped and their text kept. Everything is escaped again
// when the article is built, so nothing from the feed is used as markup.
export function descriptionLines(value: unknown): string[] {
    if (typeof value !== "string") return []
    return value
        .replace(/<\s*(?:br|\/?p|\/?div|\/?li)\b[^>]*>/gi, "\n")
        .replace(/<\/?[a-z][^>]*>/gi, "")
        .split(/\r\n?|\n/)
        .map(line => oneLine(decodeEntities(line)))
        .filter(line => line.length > 0)
}

export function escapeHtml(text: string) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function formatDate({ year, month, day }: CalendarDate) {
    return `${day} ${MONTH_NAMES[month - 1]} ${year}`
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

type Entry = { heading: string; lines: string[] }

// "none" if the feed is not the Camera's; "empty" if it has no items;
// "invalid", with the reason, if anything cannot be verified.
export function normalizeCameraOdg(
    sourceUrl: string,
    responseUrl: string,
    feed: FeedInput
): NormalizeResult {
    if (!isCameraOdgFeedUrl(sourceUrl)) return { kind: "none" }
    const guidPrefix = CAMERA_ODG_GUID_PREFIX
    const invalid = (reason: string): NormalizeResult => ({
        kind: "invalid",
        reason,
        guidPrefix,
    })
    const items: FeedItemInput[] = Array.isArray(feed?.items) ? feed.items : []
    if (items.length === 0) return { kind: "empty", guidPrefix }
    if (!isCameraOdgFeedUrl(responseUrl, true))
        return invalid("unexpected response URL")
    const session = parseChannelTitle(feed.title)
    if (!session) return invalid("channel title")
    const { legislatura, seduta, date } = session
    const link = parsePageLink(feed.link, legislatura)
    if (!link) return invalid("channel link")

    const seen = new Set<string>()
    const entries: Entry[] = []
    let earliest: Date = null
    for (const item of items) {
        if (!item || typeof item !== "object") return invalid("item")
        // Every point must be traceable, so that imports by older versions
        // can be recognized.
        if (!nonEmptyString(item.guid)) return invalid("item without GUID")
        if (parsePageLink(item.link, legislatura) !== link)
            return invalid("item link")
        const published = parsePubDate(item.pubDate)
        if (!published) return invalid("item date")
        if (
            published.date.year !== date.year ||
            published.date.month !== date.month ||
            published.date.day !== date.day
        )
            return invalid("item of another day")
        if (!earliest || published.instant < earliest)
            earliest = published.instant
        // Repeated identifiers are skipped, as when importing separately.
        if (seen.has(item.guid)) continue
        seen.add(item.guid)
        const heading = oneLine(item.title)
        const lines = descriptionLines(item.content)
        if (heading || lines.length > 0) entries.push({ heading, lines })
    }
    if (entries.length === 0) return invalid("empty items")

    const dateText = formatDate(date)
    const title = `Camera dei deputati — Ordine del giorno del ${dateText} (seduta n. ${seduta})`
    const header = [
        "Camera dei deputati — Ordine del giorno dell'Assemblea",
        `Legislatura ${legislatura}, seduta n. ${seduta} del ${dateText}`,
    ]
    const footer = "Documento ufficiale:"
    const html: string[] = header.map(line => `<p>${escapeHtml(line)}</p>`)
    const text: string[] = [...header]
    for (const entry of entries) {
        if (entry.heading) {
            html.push(`<h3>${escapeHtml(entry.heading)}</h3>`)
            text.push(entry.heading)
        }
        for (const line of entry.lines) {
            html.push(`<p>${escapeHtml(line)}</p>`)
            text.push(line)
        }
    }
    html.push(
        `<p>${escapeHtml(footer)} <a href="${escapeHtml(link)}">${escapeHtml(
            link
        )}</a></p>`
    )
    text.push(`${footer} ${link}`)

    return {
        kind: "article",
        guidPrefix,
        article: {
            guid: `${guidPrefix}legislatura-${legislatura}:seduta-${seduta}`,
            title,
            link,
            date: earliest,
            content: html.join("\n"),
            snippet: text.join("\n"),
            fragmentGuids: Array.from(seen),
        },
    }
}
