import { normalizeCameraOdg } from "./camera-odg"
import type { FeedInput, NormalizeResult } from "./types"

export type { NormalizedArticle, NormalizeResult } from "./types"

// Finds the normalizer of a feed, which may build a single article to replace
// its items. Feeds are recognized by the subscribed URL; the URL of the
// response, after redirects, is verified by the normalizer.
export function normalizeFeed(
    sourceUrl: string,
    responseUrl: string,
    feed: FeedInput
): NormalizeResult {
    return normalizeCameraOdg(sourceUrl, responseUrl, feed)
}
