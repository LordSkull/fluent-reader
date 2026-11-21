// What a feed shows: its loaded articles, with copies of the same article
// from different sources folded into one entry (see ../duplicates.ts). This
// is derived from feed.iids, which keeps every loaded article id, so loading
// more, read states and every other use of feed.iids are not affected.
import {
    DuplicateCandidate,
    DuplicateIdentity,
    MAX_DATE_DIFFERENCE_MS,
    groupDuplicates,
    identityOf,
} from "../duplicates"
import type { RootState } from "../reducer"
import { FilterType, RSSFeed } from "./feed"
import { ItemState } from "./item"

export type FeedView = {
    // Ids shown, in feed order: representatives and ungrouped articles.
    visible: number[]
    // Representative id → ids of its group, representative first. Only
    // groups of two or more articles.
    groups: Map<number, number[]>
    // Id of every grouped article → id of its representative.
    representativeOf: Map<number, number>
    // Representatives whose group may still gain copies from pages that are
    // not loaded yet.
    incomplete: Set<number>
}

const EMPTY_GROUPS = new Map<number, number[]>()

// Copies are folded only in feeds of several sources, i.e. not in the view
// of a single source.
export function groupsDuplicates(feed: RSSFeed) {
    return feed.sids.length > 1
}

// Articles are immutable in the store, so identities are computed once per
// version of an article.
const identities = new WeakMap<object, DuplicateIdentity | null>()
function cachedIdentity(item: DuplicateCandidate) {
    let identity = identities.get(item)
    if (identity === undefined) {
        identity = identityOf(item)
        identities.set(item, identity)
    }
    return identity
}

export function computeFeedView(feed: RSSFeed, items: ItemState): FeedView {
    const iids = feed.iids
    if (!groupsDuplicates(feed)) {
        return {
            visible: iids,
            groups: EMPTY_GROUPS,
            representativeOf: new Map(),
            incomplete: new Set(),
        }
    }
    const showHidden = Boolean(feed.filter.type & FilterType.ShowHidden)
    const sids = new Set(feed.sids)
    const candidates = []
    let oldest = Infinity
    for (const id of iids) {
        const item = items[id]
        if (!item) continue
        const time = item.date?.getTime?.()
        if (Number.isFinite(time) && time < oldest) oldest = time
        // A hidden article never stands for, or joins, a visible one.
        if (item.hidden && !showHidden) continue
        if (!sids.has(item.source)) continue
        candidates.push(item)
    }
    const { members, representativeOf } = groupDuplicates(
        candidates,
        cachedIdentity
    )
    if (members.size === 0) {
        return {
            visible: iids,
            groups: EMPTY_GROUPS,
            representativeOf,
            incomplete: new Set(),
        }
    }
    const visible = iids.filter(id => {
        const rep = representativeOf.get(id)
        return rep === undefined || rep === id
    })
    // Articles not loaded yet are not newer than the oldest loaded one: a
    // group can still gain them if they may fall within its time window.
    const incomplete = new Set<number>()
    if (!feed.allLoaded) {
        for (const [rep, ids] of members) {
            if (
                ids.length < feed.sids.length &&
                oldest >= items[rep].date.getTime() - MAX_DATE_DIFFERENCE_MS
            )
                incomplete.add(rep)
        }
    }
    return { visible, groups: members, representativeOf, incomplete }
}

const views = new Map<
    string,
    { feed: RSSFeed; items: ItemState; view: FeedView }
>()

// The view of a feed, recomputed only when the feed or the articles change.
export function selectFeedView(state: RootState, feedId: string): FeedView {
    const feed = state.feeds[feedId]
    if (!feed) return null
    const cached = views.get(feedId)
    if (cached && cached.feed === feed && cached.items === state.items)
        return cached.view
    const view = computeFeedView(feed, state.items)
    views.set(feedId, { feed, items: state.items, view })
    return view
}

// The id under which an article is shown in a feed: its own, or that of the
// representative of its group.
export function shownId(view: FeedView, iid: number) {
    return view.representativeOf.get(iid) ?? iid
}

// The articles of the group an article is shown in, representative first, or
// null when the article is not grouped.
export function groupOf(view: FeedView, iid: number): number[] | null {
    const rep = view.representativeOf.get(iid)
    return rep === undefined ? null : view.groups.get(rep) ?? null
}
