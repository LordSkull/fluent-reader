import { and, count, eq, inArray, lt, sql, SQL } from "drizzle-orm"
import { database, itemsTable } from "./db"
import { AppThunk } from "./utils"
import { saveSettings } from "./models/app"
import { SourceState, updateUnreadCounts } from "./models/source"
import { SourceGroup } from "../schema-types"

// Age thresholds in days offered for cleanup; 0 means every article.
export const CLEANUP_PERIODS = [7, 14, 21, 28, 0]

export type CleanupScope = "all" | "source" | "group"

export type CleanupFilter = {
    scope: CleanupScope
    // Set only when scope is "source".
    sid: number | null
    // Set only when scope is "group": the group and the sorted sources it had
    // when the filter was created. Counting and deleting are refused unless
    // the group still has exactly these sources.
    gid: number | null
    sids: readonly number[] | null
    days: number
    // Fixed when the filter is created, so the deletion uses the cutoff of
    // the confirmed preview. Null when days is 0.
    before: Date | null
}

export type CleanupResult = {
    deleted: number
    vacuumError?: unknown
    refreshError?: unknown
}

function isValidSource(sid: number, sources: SourceState) {
    return Number.isInteger(sid) && Object.hasOwn(sources, sid)
}

// The sources of a user group, sorted and without duplicates. Null unless
// exactly one group has the gid, it is not a single source entry and it has
// at least one source, all of them known.
function groupSources(
    gid: number,
    groups: SourceGroup[],
    sources: SourceState
): number[] | null {
    if (!Number.isSafeInteger(gid) || !Array.isArray(groups)) return null
    const matches = groups.filter(g => g?.gid === gid)
    if (matches.length !== 1) return null
    const group = matches[0]
    if (group.isMultiple !== true || !Array.isArray(group.sids)) return null
    if (!group.sids.every(sid => isValidSource(sid, sources))) return null
    const sids = [...new Set(group.sids)].sort((a, b) => a - b)
    return sids.length > 0 ? sids : null
}

function sameSources(a: readonly number[], b: readonly number[]) {
    return a.length === b.length && a.every((sid, i) => sid === b[i])
}

export function makeCleanupFilter(
    days: number,
    scope: CleanupScope,
    // The source when scope is "source", the group when scope is "group".
    id: number | null,
    sources: SourceState,
    now = Date.now(),
    groups: SourceGroup[] = []
): CleanupFilter | null {
    if (!CLEANUP_PERIODS.includes(days)) return null
    let sids: number[] = null
    if (scope === "source") {
        if (!isValidSource(id, sources)) return null
    } else if (scope === "group") {
        sids = groupSources(id, groups, sources)
        if (sids === null) return null
    } else if (scope !== "all") {
        return null
    }
    return {
        scope: scope,
        sid: scope === "source" ? id : null,
        gid: scope === "group" ? id : null,
        sids: sids === null ? null : Object.freeze(sids),
        days: days,
        before: days === 0 ? null : new Date(now - days * 86400000),
    }
}

// Throws instead of widening the deletion when the filter is inconsistent:
// only an explicit "all" scope may match articles of every source.
function cleanupCondition(
    filter: CleanupFilter,
    sources: SourceState,
    groups: SourceGroup[]
): SQL | undefined {
    const conditions: SQL[] = []
    if (filter.scope === "source") {
        if (
            !isValidSource(filter.sid, sources) ||
            filter.gid !== null ||
            filter.sids !== null
        )
            throw new Error("Invalid cleanup source.")
        conditions.push(eq(itemsTable.source, filter.sid))
    } else if (filter.scope === "group") {
        const sids = groupSources(filter.gid, groups, sources)
        if (filter.sid !== null || !Array.isArray(filter.sids) || !sids)
            throw new Error("Invalid cleanup group.")
        // Comparing sorted lists ignores a mere reordering of the group.
        if (!sameSources(filter.sids, sids))
            throw new Error("The group has changed since the preview.")
        conditions.push(inArray(itemsTable.source, sids))
    } else if (
        filter.scope !== "all" ||
        filter.sid !== null ||
        filter.gid !== null ||
        filter.sids !== null
    ) {
        throw new Error("Invalid cleanup scope.")
    }
    if (!CLEANUP_PERIODS.includes(filter.days))
        throw new Error("Invalid cleanup period.")
    if (filter.days !== 0) {
        if (!(filter.before instanceof Date) || isNaN(filter.before.getTime()))
            throw new Error("Invalid cleanup date.")
        conditions.push(lt(itemsTable.date, filter.before))
    } else if (filter.before !== null) {
        throw new Error("Invalid cleanup date.")
    }
    if (conditions.length > 0) return and(...conditions)
    if (filter.scope !== "all") throw new Error("Invalid cleanup scope.")
    return undefined
}

export function countArticles(
    filter: CleanupFilter
): AppThunk<Promise<number>> {
    return async (_, getState) => {
        const { sources, groups } = getState()
        const where = cleanupCondition(filter, sources, groups)
        const rows = await database
            .select({ count: count() })
            .from(itemsTable)
            .where(where)
        return rows[0]?.count ?? 0
    }
}

// The database proxy returns the values of the better-sqlite3 RunResult,
// in order: [changes, lastInsertRowid].
function deletedCount(rows: unknown[]) {
    const changes = rows?.[0]
    if (
        typeof changes !== "number" ||
        !Number.isSafeInteger(changes) ||
        changes < 0
    )
        throw new Error("Invalid cleanup result.")
    return changes
}

let cleanupRunning = false

// Deletes every article matching the filter, unread and starred ones included.
export function deleteArticles(
    filter: CleanupFilter
): AppThunk<Promise<CleanupResult>> {
    return async (dispatch, getState) => {
        if (cleanupRunning) throw new Error("A cleanup is already running.")
        const { sources, groups } = getState()
        const where = cleanupCondition(filter, sources, groups)
        cleanupRunning = true
        // Blocks closing the settings until finished and marks them changed,
        // so the feeds are reloaded from the database on exit.
        dispatch(saveSettings())
        try {
            const { rows } = await database
                .delete(itemsTable)
                .where(where)
                .run()
            const result: CleanupResult = { deleted: deletedCount(rows) }
            // The articles are already deleted: later failures are reported
            // separately from a failed deletion.
            try {
                // DELETE leaves reusable pages allocated; explicit cleanup should release them.
                await database.run(sql`VACUUM`)
            } catch (err) {
                console.error(err)
                result.vacuumError = err
            }
            try {
                await dispatch(updateUnreadCounts())
            } catch (err) {
                console.error(err)
                result.refreshError = err
            }
            return result
        } finally {
            dispatch(saveSettings())
            cleanupRunning = false
        }
    }
}
