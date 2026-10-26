import { and, count, eq, lt, sql, SQL } from "drizzle-orm"
import { database, itemsTable } from "./db"
import { AppThunk } from "./utils"
import { saveSettings } from "./models/app"
import { SourceState, updateUnreadCounts } from "./models/source"

// Age thresholds in days offered for cleanup; 0 means every article.
export const CLEANUP_PERIODS = [7, 14, 21, 28, 0]

export type CleanupScope = "all" | "source"

export type CleanupFilter = {
    scope: CleanupScope
    // Set only when scope is "source".
    sid: number | null
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

export function makeCleanupFilter(
    days: number,
    scope: CleanupScope,
    sid: number | null,
    sources: SourceState,
    now = Date.now()
): CleanupFilter | null {
    if (!CLEANUP_PERIODS.includes(days)) return null
    if (scope === "source") {
        if (!isValidSource(sid, sources)) return null
    } else if (scope !== "all") {
        return null
    }
    return {
        scope: scope,
        sid: scope === "source" ? sid : null,
        days: days,
        before: days === 0 ? null : new Date(now - days * 86400000),
    }
}

// Throws instead of widening the deletion when the filter is inconsistent:
// only an explicit "all" scope may match articles of every source.
function cleanupCondition(
    filter: CleanupFilter,
    sources: SourceState
): SQL | undefined {
    const conditions: SQL[] = []
    if (filter.scope === "source") {
        if (!isValidSource(filter.sid, sources))
            throw new Error("Invalid cleanup source.")
        conditions.push(eq(itemsTable.source, filter.sid))
    } else if (filter.scope !== "all" || filter.sid !== null) {
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
    return conditions.length > 0 ? and(...conditions) : undefined
}

export function countArticles(
    filter: CleanupFilter
): AppThunk<Promise<number>> {
    return async (_, getState) => {
        const where = cleanupCondition(filter, getState().sources)
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
        const where = cleanupCondition(filter, getState().sources)
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
