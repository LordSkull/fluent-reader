import { and, count, eq, gt, inArray, lte, max, sql } from "drizzle-orm"
import { database, itemsTable } from "./db"
import { AppThunk } from "./utils"
import { saveSettings } from "./models/app"
import { SourceState } from "./models/source"
import { RSSItem } from "./models/item"
import { FilterType } from "./models/feed"
import {
    ArticleRule,
    getRulesForTarget,
    ItemAction,
    RuleState,
} from "./models/rule"
import { getRuleTargetKey, RuleTarget, SourceGroup } from "../schema-types"

// Applies the rules to articles that are already stored. Only the hidden
// flag is ever written, and only from false to true: the database does not
// record whether an article was hidden or shown by the user or by a rule, so
// showing articles again could undo manual changes.

export type RetroErrorCode =
    | "scope"
    | "invalidRule"
    | "nonStandardRule"
    | "stale"
    | "busy"
    | "cancelled"
    | "result"

export class RetroRulesError extends Error {
    code: RetroErrorCode

    constructor(code: RetroErrorCode) {
        super(`Retroactive rules: ${code}`)
        this.code = code
    }
}

export type RetroPreview = {
    target: Readonly<RuleTarget>
    // The sorted sources of the target when the preview was made.
    sids: readonly number[]
    fingerprint: string
    // Articles of the sources, as of the start of the preview.
    examined: number
    // Articles hidden by the final decision of the rules.
    ruleHidden: number
    // Visible articles that the rules hide: the only ones to update.
    toHide: readonly number[]
    // Articles hidden by the rules that are already hidden.
    alreadyHidden: number
}

const PAGE_SIZE = 1000
// Rules created in the editor never depend on the state of an article.
const STANDARD_FILTER = FilterType.Default | FilterType.ShowHidden
const ACTIONS = new Set<string>([
    ItemAction.Read,
    ItemAction.Star,
    ItemAction.Hide,
    ItemAction.Notify,
])

function isValidSource(sid: unknown, sources: SourceState): sid is number {
    return (
        Number.isSafeInteger(sid) &&
        Object.hasOwn(sources, sid as number) &&
        sources[sid as number]?.sid === sid
    )
}

// The sorted sources of the target, or null when the target is unknown or
// inconsistent with the current state. Only an explicit "all" target covers
// every source, and the sources are always listed explicitly.
export function resolveRetroScope(
    target: RuleTarget,
    sources: SourceState,
    groups: SourceGroup[]
): number[] | null {
    if (!target || typeof target !== "object" || !sources) return null
    if (
        !Array.isArray(groups) ||
        !groups.every(g => g && Array.isArray(g.sids))
    )
        return null
    let sids: number[]
    if (target.type === "all") {
        sids = Object.values(sources).map(s => s?.sid)
        if (!sids.every(sid => isValidSource(sid, sources))) return null
    } else if (target.type === "source") {
        if (!isValidSource(target.sid, sources)) return null
        sids = [target.sid]
    } else if (target.type === "group") {
        const gid = target.gid
        if (!Number.isSafeInteger(gid)) return null
        const matches = groups.filter(g => g.gid === gid)
        if (matches.length !== 1 || matches[0].isMultiple !== true) return null
        sids = matches[0].sids
        if (sids.length === 0 || new Set(sids).size !== sids.length) return null
        if (!sids.every(sid => isValidSource(sid, sources))) return null
        // A source listed in an earlier group gets that group's rules when
        // fetched, not the rules of this one.
        const owner = (sid: number) =>
            groups.find(g => g.isMultiple && g.sids.includes(sid))
        if (!sids.every(sid => owner(sid) === matches[0])) return null
    } else {
        return null
    }
    return [...sids].sort((a, b) => a - b)
}

function checkRule(rule: ArticleRule) {
    const filter = rule?.filter
    if (
        !filter ||
        typeof filter.type !== "number" ||
        typeof filter.search !== "string" ||
        typeof rule.match !== "boolean" ||
        !rule.actions ||
        typeof rule.actions !== "object"
    )
        throw new RetroRulesError("nonStandardRule")
    if ((filter.type & STANDARD_FILTER) !== STANDARD_FILTER)
        throw new RetroRulesError("nonStandardRule")
    for (const [action, flag] of Object.entries(rule.actions)) {
        if (!ACTIONS.has(action) || typeof flag !== "boolean")
            throw new RetroRulesError("nonStandardRule")
    }
    // The editor refuses empty expressions, which would match every article.
    if (filter.search === "") throw new RetroRulesError("invalidRule")
    // FeedFilter.testItem would throw for every article. A pattern must never
    // be treated as not matching instead: rules with an inverted condition
    // would then apply to every article.
    try {
        new RegExp(
            filter.search,
            filter.type & FilterType.CaseInsensitive ? "i" : ""
        )
    } catch {
        throw new RetroRulesError("invalidRule")
    }
}

// The rules applied when fetching each source: all articles, then its group,
// then the source itself.
export function getRetroChains(
    rules: RuleState,
    groups: SourceGroup[],
    sids: readonly number[]
): Map<number, ArticleRule[]> {
    const chains = new Map<number, ArticleRule[]>()
    for (const sid of sids) {
        const chain = getRulesForTarget(rules, groups, {
            type: "source",
            sid: sid,
        })
        chain.forEach(checkRule)
        chains.set(sid, chain)
    }
    return chains
}

const hidesArticles = (chain: ArticleRule[]) =>
    chain.some(rule => Object.hasOwn(rule.actions, ItemAction.Hide))

function getFingerprint(
    target: RuleTarget,
    sids: readonly number[],
    chains: Map<number, ArticleRule[]>
) {
    return JSON.stringify([
        getRuleTargetKey(target),
        sids,
        sids.map(sid =>
            chains
                .get(sid)
                .map(rule => [
                    rule.filter.type,
                    rule.filter.search,
                    rule.match,
                    Object.entries(rule.actions).sort(([a], [b]) =>
                        a < b ? -1 : a > b ? 1 : 0
                    ),
                ])
        ),
    ])
}

// Describes the target and its rules; throws if they cannot be applied.
export function getRetroState(
    target: RuleTarget,
    rules: RuleState,
    sources: SourceState,
    groups: SourceGroup[]
) {
    const sids = resolveRetroScope(target, sources, groups)
    if (sids === null) throw new RetroRulesError("scope")
    const chains = getRetroChains(rules, groups, sids)
    return {
        sids: sids,
        chains: chains,
        fingerprint: getFingerprint(target, sids, chains),
    }
}

type StoredFields = Pick<RSSItem, "title" | "snippet" | "creator">

// Evaluates the rules as for a newly fetched article, on a copy with the
// initial state, and keeps only the hidden flag.
export function isHiddenByRules(chain: ArticleRule[], fields: StoredFields) {
    const copy = {
        title: fields.title,
        snippet: fields.snippet ?? "",
        creator: fields.creator ?? undefined,
        hasRead: false,
        starred: false,
        hidden: false,
        notify: false,
    } as RSSItem
    ArticleRule.applyAll(chain, copy)
    return copy.hidden === true
}

// Reads the articles of the target without changing anything. isCurrent is
// checked between pages; the preview is abandoned once it returns false.
export function previewRetroHide(
    target: RuleTarget,
    isCurrent: () => boolean = () => true
): AppThunk<Promise<RetroPreview>> {
    return async (_, getState) => {
        const current = () => {
            const { rules, sources, groups } = getState()
            return getRetroState(target, rules, sources, groups)
        }
        const { sids, chains, fingerprint } = current()
        const checkCurrent = () => {
            if (!isCurrent()) throw new RetroRulesError("cancelled")
            if (current().fingerprint !== fingerprint)
                throw new RetroRulesError("stale")
        }
        const toHide: number[] = []
        const preview: RetroPreview = {
            target: Object.freeze({ ...target }),
            sids: Object.freeze(sids),
            fingerprint: fingerprint,
            examined: 0,
            ruleHidden: 0,
            toHide: Object.freeze([]),
            alreadyHidden: 0,
        }
        if (sids.length === 0) return preview
        // Articles added later are not part of the preview.
        const [{ last }] = await database
            .select({ last: max(itemsTable._id) })
            .from(itemsTable)
        checkCurrent()
        if (last === null) return preview
        const hiding = sids.filter(sid => hidesArticles(chains.get(sid)))
        const others = sids.filter(sid => !hidesArticles(chains.get(sid)))
        if (others.length > 0) {
            const [{ total }] = await database
                .select({ total: count() })
                .from(itemsTable)
                .where(
                    and(
                        inArray(itemsTable.source, others),
                        lte(itemsTable._id, last)
                    )
                )
            preview.examined += total
            checkCurrent()
        }
        if (hiding.length === 0) return preview
        // Only the fields that some rule searches are transferred.
        const rules = hiding.flatMap(sid => chains.get(sid))
        const fullSearch = rules.some(
            r => r.filter.type & FilterType.FullSearch
        )
        const creatorSearch = rules.some(
            r => r.filter.type & FilterType.CreatorSearch
        )
        let after = 0
        for (;;) {
            const rows = (await database
                .select({
                    _id: itemsTable._id,
                    source: itemsTable.source,
                    title: itemsTable.title,
                    hidden: itemsTable.hidden,
                    ...(fullSearch ? { snippet: itemsTable.snippet } : {}),
                    ...(creatorSearch ? { creator: itemsTable.creator } : {}),
                })
                .from(itemsTable)
                .where(
                    and(
                        inArray(itemsTable.source, hiding),
                        gt(itemsTable._id, after),
                        lte(itemsTable._id, last)
                    )
                )
                .orderBy(itemsTable._id)
                .limit(PAGE_SIZE)) as (StoredFields & {
                _id: number
                source: number
                hidden: boolean
            })[]
            checkCurrent()
            for (const row of rows) {
                const chain = chains.get(row.source)
                if (!chain) throw new RetroRulesError("scope")
                preview.examined += 1
                if (!isHiddenByRules(chain, row)) continue
                preview.ruleHidden += 1
                if (row.hidden) preview.alreadyHidden += 1
                else toHide.push(row._id)
            }
            if (rows.length < PAGE_SIZE) break
            after = rows[rows.length - 1]._id
        }
        return { ...preview, toHide: Object.freeze([...toHide]) }
    }
}

// The database proxy returns the values of the better-sqlite3 RunResult,
// in order: [changes, lastInsertRowid].
function changedCount(rows: unknown[]) {
    const changes = rows?.[0]
    if (
        typeof changes !== "number" ||
        !Number.isSafeInteger(changes) ||
        changes < 0
    )
        throw new RetroRulesError("result")
    return changes
}

let retroRunning = false

// Hides the visible articles of a preview in a single statement, which either
// changes all of them or none. Refused when the target, its sources or its
// rules have changed since the preview. Articles hidden, deleted or added in
// the meantime are left as they are.
export function applyRetroHide(
    preview: RetroPreview
): AppThunk<Promise<number>> {
    return async (dispatch, getState) => {
        if (retroRunning) throw new RetroRulesError("busy")
        const { rules, sources, groups } = getState()
        const { sids, fingerprint } = getRetroState(
            preview?.target,
            rules,
            sources,
            groups
        )
        if (fingerprint !== preview.fingerprint)
            throw new RetroRulesError("stale")
        const ids = preview.toHide
        if (
            !Array.isArray(ids) ||
            ids.length === 0 ||
            !ids.every(id => Number.isSafeInteger(id) && id > 0)
        )
            throw new RetroRulesError("result")
        retroRunning = true
        // Blocks closing the settings until finished and marks them changed,
        // so the feeds are reloaded from the database on exit.
        dispatch(saveSettings())
        try {
            // One JSON parameter instead of a placeholder per article.
            const json = JSON.stringify(ids)
            const { rows } = await database
                .update(itemsTable)
                .set({ hidden: true })
                .where(
                    and(
                        eq(itemsTable.hidden, false),
                        inArray(itemsTable.source, sids),
                        sql`${itemsTable._id} IN (SELECT value FROM json_each(${json}))`
                    )
                )
                .run()
            return changedCount(rows)
        } finally {
            dispatch(saveSettings())
            retroRunning = false
        }
    }
}
