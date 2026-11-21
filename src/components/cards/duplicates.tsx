import * as React from "react"
import { useState } from "react"
import intl from "react-intl-universal"
import { makeStyles } from "@griffel/react"
import {
    ContextualMenu,
    ContextualMenuItemType,
    DirectionalHint,
    IContextualMenuItem,
} from "@fluentui/react/lib/ContextualMenu"
import { Card } from "./card"

const useStyles = makeStyles({
    badge: {
        "flexShrink": 0,
        "alignSelf": "center",
        "height": "16px",
        "minWidth": "16px",
        "boxSizing": "border-box",
        "margin": "0 4px",
        "padding": "0 5px",
        "border": "1px solid currentColor",
        "borderRadius": "8px",
        "backgroundColor": "transparent",
        "color": "inherit",
        "opacity": 0.75,
        "font": "inherit",
        "fontSize": "11px",
        "lineHeight": "14px",
        "cursor": "pointer",
        ":hover": { opacity: 1 },
    },
})

const stop = (e: React.SyntheticEvent) => e.stopPropagation()

// The entries of a menu of copies: one per copy, which opens that copy only.
// The open copy is checked. An incomplete list says so.
export function duplicateMenuItems(
    duplicates: Card.Duplicates,
    currentItem: number,
    open: (copy: Card.Copy, e: React.MouseEvent | React.KeyboardEvent) => void
): IContextualMenuItem[] {
    const count = duplicates.copies.length
    const items: IContextualMenuItem[] = [
        {
            key: "header",
            itemType: ContextualMenuItemType.Header,
            text: duplicates.incomplete
                ? intl.get("duplicates.headerIncomplete", { count })
                : intl.get("duplicates.header", { count }),
        },
        ...duplicates.copies.map(
            (copy): IContextualMenuItem => ({
                key: String(copy.item._id),
                text: copy.source.name,
                secondaryText: [
                    copy.item.date.toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                    }),
                    copy.item.hasRead ? null : intl.get("duplicates.unread"),
                    copy.item.starred ? "★" : null,
                ]
                    .filter(Boolean)
                    .join(" · "),
                title: copy.item.link,
                canCheck: true,
                checked: copy.item._id === currentItem,
                onClick: e => open(copy, e),
            })
        ),
    ]
    if (duplicates.incomplete) {
        items.push({
            key: "incomplete",
            text: intl.get("duplicates.mayHaveMore"),
            disabled: true,
        })
    }
    return items
}

// The count of copies of a card's article, which lists them on click.
function DuplicatesBadge({ card }: { card: Card.Props }) {
    const classes = useStyles()
    const [target, setTarget] = useState<HTMLElement>(null)
    const { copies, incomplete } = card.duplicates
    const label = incomplete
        ? intl.get("duplicates.headerIncomplete", { count: copies.length })
        : intl.get("duplicates.header", { count: copies.length })
    return (
        // The menu is rendered in a layer, but its events still bubble to the
        // card through React: they must not open or select the card.
        <span
            onClick={stop}
            onMouseUp={stop}
            onMouseDown={stop}
            onKeyDown={stop}
            onContextMenu={stop}>
            <button
                type="button"
                className={classes.badge}
                // Arrow keys keep moving between cards.
                tabIndex={-1}
                data-is-focusable={false}
                // Clicks keep the focus where it is, e.g. on the card.
                onMouseDown={e => e.preventDefault()}
                aria-haspopup="menu"
                aria-expanded={Boolean(target)}
                aria-label={label}
                title={label}
                onClick={e => {
                    e.preventDefault()
                    setTarget(e.currentTarget)
                }}>
                {"×" + copies.length + (incomplete ? "+" : "")}
            </button>
            {target && (
                <ContextualMenu
                    target={target}
                    directionalHint={DirectionalHint.bottomLeftEdge}
                    items={duplicateMenuItems(
                        card.duplicates,
                        card.currentItem,
                        (copy, e) =>
                            Card.openArticle(
                                card,
                                card.feedId,
                                copy.item,
                                copy.source,
                                e
                            )
                    )}
                    onDismiss={() => setTarget(null)}
                />
            )}
        </span>
    )
}

export const duplicatesBadge = (card: Card.Props) =>
    card.duplicates ? <DuplicatesBadge card={card} /> : null
