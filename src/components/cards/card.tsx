import * as React from "react"
import { RSSSource, SourceOpenTarget } from "../../scripts/models/source"
import { RSSItem } from "../../scripts/models/item"
import { platformCtrl } from "../../scripts/utils"
import { FeedFilter } from "../../scripts/models/feed"
import { ViewConfigs } from "../../schema-types"

export namespace Card {
    // A copy of the article published by another source.
    export type Copy = { item: RSSItem; source: RSSSource }
    export type Duplicates = {
        // Every copy, the shown article first.
        copies: Copy[]
        // More copies may be loaded with the next pages.
        incomplete: boolean
    }

    export type Props = {
        feedId: string
        item: RSSItem
        source: RSSSource
        filter: FeedFilter
        selected?: boolean
        viewConfigs?: ViewConfigs
        // Copies of the article from other sources, shown as one card.
        duplicates?: Duplicates
        // The open article, which may be any copy.
        currentItem?: number
        shortcuts: (item: RSSItem, e: KeyboardEvent) => void
        markRead: (item: RSSItem) => void
        contextMenu: (feedId: string, item: RSSItem, e) => void
        showItem: (fid: string, item: RSSItem) => void
    }

    const openInBrowser = (props: Props, e: React.MouseEvent) => {
        props.markRead(props.item)
        window.utils.openExternal(props.item.link, platformCtrl(e))
    }

    // Opens an article as clicking its card does, as configured for its own
    // source. Only this article is marked as read.
    export const openArticle = (
        actions: Pick<Props, "markRead" | "showItem">,
        feedId: string,
        item: RSSItem,
        source: RSSSource,
        e?: React.MouseEvent | React.KeyboardEvent | MouseEvent | KeyboardEvent
    ) => {
        actions.markRead(item)
        if (source.openTarget === SourceOpenTarget.External) {
            window.utils.openExternal(item.link, Boolean(e && platformCtrl(e)))
        } else {
            actions.showItem(feedId, item)
        }
    }

    export const bindEventsToProps = (props: Props) => ({
        onClick: (e: React.MouseEvent) => onClick(props, e),
        onMouseUp: (e: React.MouseEvent) => onMouseUp(props, e),
        onKeyDown: (e: React.KeyboardEvent) => onKeyDown(props, e),
    })

    const onClick = (props: Props, e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        openArticle(props, props.feedId, props.item, props.source, e)
    }

    const onMouseUp = (props: Props, e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        switch (e.button) {
            case 1:
                openInBrowser(props, e)
                break
            case 2:
                props.contextMenu(props.feedId, props.item, e)
        }
    }

    // Shift+F10 and the Menu key open the menu of the focused card, as a
    // right click does: it lists the copies of the article, if any.
    export const isContextMenuKey = (e: React.KeyboardEvent | KeyboardEvent) =>
        e.key === "ContextMenu" ||
        (e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey)

    const onKeyDown = (props: Props, e: React.KeyboardEvent) => {
        if (isContextMenuKey(e)) {
            e.preventDefault()
            e.stopPropagation()
            props.contextMenu(props.feedId, props.item, e)
            return
        }
        props.shortcuts(props.item, e.nativeEvent)
    }
}
