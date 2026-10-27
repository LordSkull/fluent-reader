import * as React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import intl from "react-intl-universal"
import {
    Button,
    Dialog,
    DialogActions,
    DialogBody,
    DialogContent,
    DialogSurface,
    DialogTitle,
    MessageBar,
    MessageBarBody,
    Spinner,
    Text,
} from "@fluentui/react-components"
import { RuleTarget, SourceGroup } from "../../../schema-types"
import { RuleState } from "../../../scripts/models/rule"
import { SourceState } from "../../../scripts/models/source"
import { useAppDispatch } from "../../../scripts/reducer"
import {
    applyRetroHide,
    getRetroState,
    previewRetroHide,
    RetroPreview,
    RetroRulesError,
} from "../../../scripts/retro-rules"
import { useStyles } from "./styles"

type RetroApplyProps = {
    target: RuleTarget
    sources: SourceState
    groups: SourceGroup[]
    rules: RuleState
    // Set while the rules are being saved.
    locked: boolean
    onBusyChange: (busy: boolean) => void
}

type RetroStatus =
    | { kind: "idle"; stale?: boolean }
    | { kind: "previewing" }
    | { kind: "previewError"; error: unknown }
    | { kind: "ready"; preview: RetroPreview; scope: string }
    | { kind: "applying" }
    | { kind: "done"; changed: number; expected: number }
    | { kind: "applyError"; error: unknown }

const ERROR_KEYS = {
    scope: "rules.retroErrorScope",
    invalidRule: "rules.retroErrorInvalidRule",
    nonStandardRule: "rules.retroErrorNonStandard",
    stale: "rules.retroErrorStale",
    busy: "rules.retroErrorBusy",
}

function errorText(error: unknown) {
    if (error instanceof RetroRulesError && ERROR_KEYS[error.code])
        return intl.get(ERROR_KEYS[error.code])
    // Drizzle errors repeat the whole query and its parameters, including
    // every article id; the database error itself is the cause.
    const cause = error instanceof Error ? error.cause : undefined
    if (cause instanceof Error) return cause.message
    return error instanceof Error ? error.message : String(error)
}

function scopeText(
    target: RuleTarget,
    sources: SourceState,
    groups: SourceGroup[],
    sids: readonly number[]
) {
    if (target.type === "all") return intl.get("rules.retroScopeAll")
    if (target.type === "source")
        return intl.get("rules.retroScopeSource", {
            name: sources[target.sid]?.name ?? "",
        })
    return intl.get("rules.retroScopeGroup", {
        name: groups.find(g => g.gid === target.gid)?.name ?? "",
        count: sids.length,
    })
}

// Hides the visible saved articles that the rules of the target would hide
// when fetched, after a preview and an explicit confirmation.
export function RetroApply({
    target,
    sources,
    groups,
    rules,
    locked,
    onBusyChange,
}: RetroApplyProps) {
    const classes = useStyles()
    const dispatch = useAppDispatch()
    const [status, setStatus] = useState<RetroStatus>({ kind: "idle" })
    const [confirmOpen, setConfirmOpen] = useState(false)
    // Each preview gets a new sequence number. Results of older previews and
    // of previews made before unmounting are discarded.
    const seq = useRef(0)
    const mounted = useRef(true)
    const applying = useRef(false)

    useEffect(
        () => () => {
            mounted.current = false
            seq.current++
        },
        []
    )

    // Changes only when the sources or rules of the target actually change,
    // not on every new state object.
    const fingerprint = useMemo(() => {
        try {
            return getRetroState(target, rules, sources, groups).fingerprint
        } catch {
            return null
        }
    }, [target, rules, sources, groups])
    const lastFingerprint = useRef(fingerprint)
    useEffect(() => {
        if (lastFingerprint.current === fingerprint) return
        lastFingerprint.current = fingerprint
        if (status.kind === "previewing" || status.kind === "ready") {
            seq.current++
            setConfirmOpen(false)
            setStatus({ kind: "idle", stale: true })
        }
    }, [fingerprint])

    const busy = status.kind === "previewing" || status.kind === "applying"

    async function preview() {
        if (busy || locked || applying.current) return
        const current = ++seq.current
        setConfirmOpen(false)
        setStatus({ kind: "previewing" })
        try {
            const result = await dispatch(
                previewRetroHide(target, () => seq.current === current)
            )
            if (seq.current !== current) return
            setStatus({
                kind: "ready",
                preview: result,
                scope: scopeText(target, sources, groups, result.sids),
            })
        } catch (error) {
            if (seq.current !== current) return
            console.error(error)
            setStatus({ kind: "previewError", error: error })
        }
    }

    async function apply() {
        if (status.kind !== "ready" || locked || applying.current) return
        const preview = status.preview
        if (preview.toHide.length === 0) return
        // The preview is consumed: it cannot be confirmed twice.
        applying.current = true
        seq.current++
        setConfirmOpen(false)
        setStatus({ kind: "applying" })
        onBusyChange(true)
        try {
            const changed = await dispatch(applyRetroHide(preview))
            if (mounted.current)
                setStatus({
                    kind: "done",
                    changed: changed,
                    expected: preview.toHide.length,
                })
        } catch (error) {
            console.error(error)
            if (mounted.current) setStatus({ kind: "applyError", error: error })
        } finally {
            applying.current = false
            if (mounted.current) onBusyChange(false)
        }
    }

    function summary() {
        switch (status.kind) {
            case "previewing":
                return (
                    <Spinner
                        size="tiny"
                        labelPosition="after"
                        label={intl.get("rules.retroPreviewing")}
                    />
                )
            case "applying":
                return (
                    <Spinner
                        size="tiny"
                        labelPosition="after"
                        label={intl.get("rules.retroApplying")}
                    />
                )
            case "idle":
                return (
                    status.stale && (
                        <MessageBar intent="warning">
                            <MessageBarBody>
                                {intl.get("rules.retroErrorStale")}
                            </MessageBarBody>
                        </MessageBar>
                    )
                )
            case "previewError":
                return (
                    <MessageBar intent="error">
                        <MessageBarBody>
                            {intl.get("rules.retroPreviewFailed", {
                                error: errorText(status.error),
                            })}
                        </MessageBarBody>
                    </MessageBar>
                )
            case "applyError":
                return (
                    <MessageBar intent="error">
                        <MessageBarBody>
                            {intl.get("rules.retroFailed", {
                                error: errorText(status.error),
                            })}
                        </MessageBarBody>
                    </MessageBar>
                )
            case "done":
                return (
                    <MessageBar intent="success">
                        <MessageBarBody>
                            {intl.get("rules.retroDone", {
                                count: status.changed,
                            })}
                            {status.changed < status.expected &&
                                " " +
                                    intl.get("rules.retroSkipped", {
                                        count: status.expected - status.changed,
                                    })}
                        </MessageBarBody>
                    </MessageBar>
                )
            case "ready": {
                const { preview } = status
                return (
                    <div
                        className={classes.fieldset}
                        role="status"
                        data-testid="rules-retro-preview">
                        <Text className={classes.hint}>
                            {intl.get("rules.retroExamined", {
                                count: preview.examined,
                            })}
                            <br />
                            {intl.get("rules.retroRuleHidden", {
                                count: preview.ruleHidden,
                            })}
                            <br />
                            {intl.get("rules.retroToHide", {
                                count: preview.toHide.length,
                            })}
                            <br />
                            {intl.get("rules.retroAlreadyHidden", {
                                count: preview.alreadyHidden,
                            })}
                        </Text>
                        {preview.toHide.length === 0 && (
                            <Text>{intl.get("rules.retroNone")}</Text>
                        )}
                    </div>
                )
            }
        }
    }

    const ready = status.kind === "ready" ? status : null
    return (
        <fieldset className={classes.fieldset} disabled={locked || busy}>
            <Text weight="semibold">{intl.get("rules.retroTitle")}</Text>
            <Text className={classes.hint}>{intl.get("rules.retroIntro")}</Text>
            <div className={classes.row}>
                <Button disabled={locked || busy} onClick={preview}>
                    {intl.get("rules.retroPreview")}
                </Button>
                <Button
                    appearance="primary"
                    disabled={
                        locked ||
                        busy ||
                        !ready ||
                        ready.preview.toHide.length === 0
                    }
                    onClick={() => setConfirmOpen(true)}>
                    {intl.get("rules.retroApply")}
                </Button>
            </div>
            {summary()}
            <Dialog
                open={confirmOpen && ready !== null}
                onOpenChange={(_, data) => setConfirmOpen(data.open)}>
                <DialogSurface>
                    <DialogBody>
                        <DialogTitle>
                            {intl.get("rules.retroConfirmTitle")}
                        </DialogTitle>
                        <DialogContent className={classes.fieldset}>
                            {ready && (
                                <Text>
                                    {intl.get("rules.retroConfirmBody", {
                                        count: ready.preview.toHide.length,
                                        scope: ready.scope,
                                    })}
                                </Text>
                            )}
                            <Text>{intl.get("rules.retroConfirmKeep")}</Text>
                            <Text>{intl.get("rules.retroConfirmWarn")}</Text>
                        </DialogContent>
                        <DialogActions>
                            <Button appearance="primary" onClick={apply}>
                                {intl.get("rules.retroConfirm")}
                            </Button>
                            <Button onClick={() => setConfirmOpen(false)}>
                                {intl.get("cancel")}
                            </Button>
                        </DialogActions>
                    </DialogBody>
                </DialogSurface>
            </Dialog>
        </fieldset>
    )
}
