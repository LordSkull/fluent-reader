// Storage of articles that a normalizer built from all the items of a feed
// (see ../rss-normalizers). Unlike ordinary articles, which are never changed
// once imported, an aggregated article is updated in place when the feed
// changes. Its row, its _id and everything the user or the rules decided
// about it are kept; only the editorial fields are rewritten.
import { and, asc, eq, sql, SQL } from "drizzle-orm"
import { database, itemsTable } from "../db"
import { getValidDate } from "../date"
import type { RSSItem } from "./item"

export type AggregateCandidate = {
    // A new article, with the rules already applied. They only take effect
    // if the article is inserted.
    item: RSSItem
    // Conditions matching any of the merged items as older versions stored
    // it: by GUID, or without one by title, link and date, exactly as when
    // checking an item for import (see RSSSource.checkItems).
    fragments: SQL[]
}

export type StoredAggregates = {
    inserted: RSSItem[]
    updated: RSSItem[]
    failed: { sid: number; err: unknown }[]
}

function findAggregate(sid: number, guid: string) {
    return database
        .select({
            _id: itemsTable._id,
            title: itemsTable.title,
            link: itemsTable.link,
            date: itemsTable.date,
            content: itemsTable.content,
            snippet: itemsTable.snippet,
        })
        .from(itemsTable)
        .where(and(eq(itemsTable.source, sid), eq(itemsTable.guid, guid)))
        .orderBy(asc(itemsTable._id))
        .limit(1)
        .then(rows => rows[0])
}

async function hasFragments(sid: number, fragments: SQL[]) {
    for (const fragment of fragments) {
        const rows = await database
            .select({ _id: itemsTable._id })
            .from(itemsTable)
            .where(and(eq(itemsTable.source, sid), fragment))
            .limit(1)
        if (rows.length > 0) return true
    }
    return false
}

// Whether a source has any article built by the normalizer whose GUIDs start
// with the prefix.
export async function hasAggregates(sid: number, guidPrefix: string) {
    const rows = await database
        .select({ _id: itemsTable._id })
        .from(itemsTable)
        .where(
            and(
                eq(itemsTable.source, sid),
                sql`substr(${itemsTable.guid}, 1, ${guidPrefix.length}) = ${guidPrefix}`
            )
        )
        .limit(1)
    return rows.length > 0
}

// A sitting that older versions already imported as separate items stays
// that way: its new items are imported separately too, and nothing is
// merged, moved or deleted. A sitting with an aggregated article keeps it.
export async function isLegacyAggregate(
    sid: number,
    guid: string,
    fragments: SQL[]
) {
    if (await findAggregate(sid, guid)) return false
    return await hasFragments(sid, fragments)
}

async function storeAggregate(
    candidate: AggregateCandidate
): Promise<{ inserted?: RSSItem; updated?: RSSItem }> {
    const item = candidate.item
    const editorial = {
        title: item.title,
        link: item.link,
        date: getValidDate(item.date, item.fetchedDate),
        content: item.content,
        snippet: item.snippet,
    }
    const existing = await findAggregate(item.source, item.guid)
    if (existing) {
        if (
            existing.title === editorial.title &&
            existing.link === editorial.link &&
            existing.date.getTime() === editorial.date.getTime() &&
            existing.content === editorial.content &&
            existing.snippet === editorial.snippet
        )
            return {}
        const rows = (await database
            .update(itemsTable)
            .set(editorial)
            .where(
                and(
                    eq(itemsTable._id, existing._id),
                    eq(itemsTable.source, item.source),
                    eq(itemsTable.guid, item.guid)
                )
            )
            .returning()) as unknown as RSSItem[]
        return rows.length > 0 ? { updated: rows[0] } : {}
    }
    // The separate items may have been imported since the feed was checked.
    if (await hasFragments(item.source, candidate.fragments)) return {}
    const rows = (await database
        .insert(itemsTable)
        .values({
            ...editorial,
            source: item.source,
            guid: item.guid,
            fetchedDate: getValidDate(item.fetchedDate, editorial.date),
            thumb: item.thumb || null,
            creator: item.creator || null,
            hasRead: item.hasRead,
            starred: item.starred,
            hidden: item.hidden,
            notify: item.notify,
            serviceRef: null,
        })
        .returning()) as unknown as RSSItem[]
    return { inserted: rows[0] }
}

// Checking for an article and writing it happen in one step for all callers,
// so that concurrent fetches cannot insert the same article twice.
let queue: Promise<unknown> = Promise.resolve()

export function storeAggregates(
    candidates: AggregateCandidate[]
): Promise<StoredAggregates> {
    const run = queue.then(async () => {
        const result: StoredAggregates = {
            inserted: [],
            updated: [],
            failed: [],
        }
        for (const candidate of candidates) {
            try {
                const { inserted, updated } = await storeAggregate(candidate)
                if (inserted) result.inserted.push(inserted)
                if (updated) result.updated.push(updated)
            } catch (err) {
                result.failed.push({ sid: candidate.item.source, err })
            }
        }
        return result
    })
    queue = run.catch(() => {})
    return run
}
