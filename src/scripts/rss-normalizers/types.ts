// The parts of a parsed feed that normalizers read. Values come from the feed
// and are checked before use.
export type FeedItemInput = {
    title?: unknown
    link?: unknown
    guid?: unknown
    pubDate?: unknown
    content?: unknown
}

export type FeedInput = {
    title?: unknown
    link?: unknown
    items?: FeedItemInput[]
}

// One article built from all the items of a feed. Its GUID is stable, so that
// later versions of the same feed update the article instead of adding one.
export type NormalizedArticle = {
    guid: string
    title: string
    link: string
    date: Date
    content: string
    snippet: string
    // The GUIDs of the merged items, which older versions stored separately.
    fragmentGuids: string[]
}

// What a normalizer makes of a fetched feed:
// - none: the normalizer does not apply; the feed is imported as published.
// - empty: the feed is known but has no items; nothing is imported.
// - invalid: the feed is known but could not be verified, for the reason
//   given. Its items must not be merged.
// - article: the feed is known and verified.
// guidPrefix starts the GUID of every article the normalizer builds.
export type NormalizeResult =
    | { kind: "none" }
    | { kind: "empty"; guidPrefix: string }
    | { kind: "invalid"; reason: string; guidPrefix: string }
    | { kind: "article"; article: NormalizedArticle; guidPrefix: string }
