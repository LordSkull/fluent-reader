import * as React from "react"
import { useEffect, useRef, useState } from "react"
import intl from "react-intl-universal"
import {
    urlTest,
    byteToMB,
    calculateItemSize,
    getSearchEngineName,
} from "../../scripts/utils"
import { ThemeSettings, SearchEngines, SourceGroup } from "../../schema-types"
import {
    getThemeSettings,
    setThemeSettings,
    exportAll,
} from "../../scripts/settings"
import {
    Button,
    Dropdown,
    Field,
    Input,
    Option,
    RadioGroup,
    Radio,
    Switch,
    Text,
    tokens,
} from "@fluentui/react-components"
import { makeStyles, mergeClasses } from "@griffel/react"
import { DangerButton } from "../utils/DangerButton"
import { SourceState } from "../../scripts/models/source"
import {
    CLEANUP_PERIODS,
    CleanupFilter,
    CleanupResult,
    CleanupScope,
    makeCleanupFilter,
} from "../../scripts/cleanup"

type AppTabProps = {
    sources: SourceState
    groups: SourceGroup[]
    setLanguage: (option: string) => void
    setFetchInterval: (interval: number) => void
    countArticles: (filter: CleanupFilter) => Promise<number>
    deleteArticles: (filter: CleanupFilter) => Promise<CleanupResult>
    importAll: () => Promise<void>
}

// count is undefined while counting.
type CleanupPreview = {
    seq: number
    filter: CleanupFilter
    count?: number
    failed?: boolean
}

type CleanupSelection = {
    deleteIndex: string
    cleanupScope: CleanupScope
    cleanupSid: number
    cleanupGid: number
}

type CleanupOption = { value: string; id: number; text: string }

// Sorted by name; duplicate names are told apart by their URL.
function cleanupSourceOptions(sources: SourceState): CleanupOption[] {
    const sorted = Object.values(sources).sort(
        (a, b) => a.name.localeCompare(b.name) || a.sid - b.sid
    )
    const names = new Map<string, number>()
    for (let source of sorted)
        names.set(source.name, (names.get(source.name) || 0) + 1)
    return sorted.map(source => ({
        value: String(source.sid),
        id: source.sid,
        text:
            names.get(source.name) > 1
                ? `${source.name} (${source.url})`
                : source.name,
    }))
}

// User groups only, keyed by gid and sorted by name; duplicate names are
// numbered in the order the groups were created.
function cleanupGroupOptions(groups: SourceGroup[]): CleanupOption[] {
    const sorted = groups
        .filter(group => group.isMultiple === true)
        .sort(
            (a, b) =>
                String(a.name).localeCompare(String(b.name)) || a.gid - b.gid
        )
    const names = new Map<string, number>()
    for (let group of sorted)
        names.set(group.name, (names.get(group.name) || 0) + 1)
    const numbers = new Map<string, number>()
    return sorted.map(group => {
        const n = (numbers.get(group.name) || 0) + 1
        numbers.set(group.name, n)
        return {
            value: String(group.gid),
            id: group.gid,
            text:
                names.get(group.name) > 1 ? `${group.name} (${n})` : group.name,
        }
    })
}

// Drizzle wraps database errors; the cause carries the actual reason.
const cleanupError = (err: unknown) =>
    String(err instanceof Error && err.cause ? err.cause : err)

function cleanupResultMessage(result: CleanupResult) {
    if (result.vacuumError)
        return intl.get("app.cleanupVacuumFailed", {
            count: result.deleted,
            error: cleanupError(result.vacuumError),
        })
    if (result.refreshError)
        return intl.get("app.cleanupRefreshFailed", {
            count: result.deleted,
            error: cleanupError(result.refreshError),
        })
    return intl.get("app.cleanupDone", { count: result.deleted })
}

const useStyles = makeStyles({
    root: { display: "flex", flexDirection: "column", gap: "16px" },
    row: { display: "flex", gap: "8px", alignItems: "flex-start" },
    section: { display: "flex", flexDirection: "column", gap: "4px" },
    grow: { flex: 1, minWidth: 0 },
    dropdown: { width: "200px", minWidth: 0 },
    cleanup: { width: "100%", minWidth: 0 },
    proxy: { gridTemplateColumns: "1fr auto", alignItems: "center" },
    hint: { color: tokens.colorNeutralForeground3 },
})

function AppTab({
    sources,
    groups,
    setLanguage,
    setFetchInterval,
    countArticles,
    deleteArticles,
    importAll,
}: AppTabProps) {
    const classes = useStyles()
    const [locale, setLocale] = useState(() =>
        window.settings.getLocaleSettings()
    )
    const [theme, setTheme] = useState(getThemeSettings)
    const [fetchInterval, setSelectedFetchInterval] = useState(() =>
        String(window.settings.getFetchInterval())
    )
    const [searchEngine, setSearchEngine] = useState(() =>
        window.settings.getSearchEngine()
    )
    const [pacStatus, setPacStatus] = useState(() =>
        window.settings.getProxyStatus()
    )
    const [pacUrl, setPacUrl] = useState(() => window.settings.getProxy())
    const [itemSize, setItemSize] = useState<string>(null)
    const [cacheSize, setCacheSize] = useState<string>(null)
    const [selection, setSelection] = useState<CleanupSelection>({
        deleteIndex: null,
        cleanupScope: "all",
        cleanupSid: null,
        cleanupGid: null,
    })
    // Incremented to count the current selection again.
    const [previewRequest, setPreviewRequest] = useState(0)
    const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview>(null)
    const [cleanupMessage, setCleanupMessage] = useState<string>(null)
    const [deleting, setDeleting] = useState(false)
    // Each selection gets a new sequence number. Counts of older selections
    // are discarded, and the DangerButton is keyed by it so that a pending
    // confirmation never carries over to another selection.
    const cleanupSeq = useRef(0)
    const deletingRef = useRef(false)
    const mounted = useRef(true)
    const prevSources = useRef(sources)
    const prevGroups = useRef(groups)

    useEffect(() => {
        mounted.current = true
        calculateItemSize().then(size => {
            if (mounted.current) setItemSize(byteToMB(size))
        })
        window.utils.getCacheSize().then(size => {
            if (mounted.current) setCacheSize(byteToMB(size))
        })
        return () => {
            mounted.current = false
            // Discards the pending count.
            cleanupSeq.current++
        }
    }, [])

    const { deleteIndex, cleanupScope, cleanupSid, cleanupGid } = selection

    function selectCleanup(changes: Partial<CleanupSelection>) {
        setSelection(current => ({ ...current, ...changes }))
        setCleanupMessage(null)
        setPreviewRequest(n => n + 1)
    }

    useEffect(() => {
        const seq = ++cleanupSeq.current
        const filter =
            deleteIndex === null
                ? null
                : makeCleanupFilter(
                      parseInt(deleteIndex),
                      cleanupScope,
                      cleanupScope === "group" ? cleanupGid : cleanupSid,
                      sources,
                      Date.now(),
                      groups
                  )
        if (filter === null) {
            setCleanupPreview(null)
            return
        }
        setCleanupPreview({ seq: seq, filter: filter })
        const setCount = (count: number, failed = false) => {
            if (!mounted.current || seq !== cleanupSeq.current) return
            setCleanupPreview(preview =>
                preview?.seq === seq
                    ? { ...preview, count: count, failed: failed }
                    : preview
            )
        }
        countArticles(filter).then(
            count => setCount(count),
            err => {
                console.error(err)
                setCount(undefined, true)
            }
        )
        // Counted again only when the selection changes or is refreshed.
    }, [selection, previewRequest])

    useEffect(() => {
        const sourcesChanged = prevSources.current !== sources
        const lastGroups = prevGroups.current
        prevSources.current = sources
        prevGroups.current = groups
        const changes: Partial<CleanupSelection> = {}
        let refresh = false
        if (sourcesChanged && cleanupSid !== null && !(cleanupSid in sources)) {
            changes.cleanupSid = null
            refresh = true
        }
        if (lastGroups !== groups && cleanupGid !== null) {
            const find = (list: SourceGroup[]) =>
                list.find(g => g.isMultiple === true && g.gid === cleanupGid)
            // Compared as sets: reordering the sources changes nothing.
            const members = (group: SourceGroup) =>
                group ? [...new Set(group.sids)].sort().join() : null
            const group = find(groups)
            if (!group) {
                changes.cleanupGid = null
                refresh = true
            } else if (
                cleanupScope === "group" &&
                members(group) !== members(find(lastGroups))
            ) {
                // Replaces the preview and any pending confirmation.
                refresh = true
            }
        }
        if (refresh) selectCleanup(changes)
    }, [sources, groups])

    const languageOptions = [
        { value: "default", text: intl.get("followSystem") },
        { value: "de", text: "Deutsch" },
        { value: "en-US", text: "English" },
        { value: "es", text: "Español" },
        { value: "cs", text: "Čeština" },
        { value: "fr-FR", text: "Français" },
        { value: "it", text: "Italiano" },
        { value: "nl", text: "Nederlands" },
        { value: "pt-BR", text: "Português do Brasil" },
        { value: "pt-PT", text: "Português de Portugal" },
        { value: "sk-SK", text: "Slovenčina" },
        { value: "fi-FI", text: "Suomi" },
        { value: "sv", text: "Svenska" },
        { value: "tr", text: "Türkçe" },
        { value: "uk", text: "Українська" },
        { value: "ru", text: "Русский" },
        { value: "ko", text: "한글" },
        { value: "ja", text: "日本語" },
        { value: "zh-CN", text: "中文（简体）" },
        { value: "zh-TW", text: "中文（繁體）" },
    ]
    const fetchIntervalOptions = [0, 10, 15, 20, 30, 45, 60].map(minutes => ({
        value: String(minutes),
        text:
            minutes === 0
                ? intl.get("app.never")
                : minutes === 60
                ? intl.get("time.hour", { h: 1 })
                : intl.get("time.minute", { m: minutes }),
    }))
    const searchEngineOptions = [
        SearchEngines.Google,
        SearchEngines.Bing,
        SearchEngines.Baidu,
        SearchEngines.DuckDuckGo,
    ]
    const deleteOptions = CLEANUP_PERIODS.map(days => ({
        value: String(days),
        text: days
            ? intl.get("app.daysAgo", { days })
            : intl.get("app.deleteAll"),
    }))
    const sourceOptions = cleanupSourceOptions(sources)
    const groupOptions = cleanupGroupOptions(groups)
    const validPacUrl = urlTest(pacUrl)
    const pacError = pacUrl && !validPacUrl ? intl.get("app.badUrl") : ""

    // The selection is locked while deleting and while counting it.
    const cleanupLocked =
        deleting ||
        (cleanupPreview !== null &&
            cleanupPreview.count === undefined &&
            !cleanupPreview.failed)

    function cleanupSummary(): string {
        if (deleting) return intl.get("app.cleanupDeleting")
        const preview = cleanupPreview
        if (preview === null) {
            // A group without sources yields no filter: nothing to delete.
            return cleanupScope === "group" &&
                cleanupGid !== null &&
                deleteIndex !== null
                ? intl.get("app.cleanupNone")
                : null
        }
        if (preview.failed) return intl.get("app.cleanupCountFailed")
        if (preview.count === undefined) return intl.get("app.cleanupCounting")
        if (preview.count === 0) return intl.get("app.cleanupNone")
        const { scope, sid, gid, days } = preview.filter
        if (scope === "all") {
            const params = { count: preview.count, days: days }
            return days === 0
                ? intl.get("app.cleanupPreviewAllEvery", params)
                : intl.get("app.cleanupPreviewAll", params)
        }
        if (scope === "group") {
            const option = groupOptions.find(o => o.id === gid)
            const params = {
                count: preview.count,
                days: days,
                name: option ? option.text : String(gid),
            }
            return days === 0
                ? intl.get("app.cleanupPreviewGroupEvery", params)
                : intl.get("app.cleanupPreviewGroup", params)
        }
        const option = sourceOptions.find(o => o.id === sid)
        const params = {
            count: preview.count,
            days: days,
            name: option ? option.text : String(sid),
        }
        return days === 0
            ? intl.get("app.cleanupPreviewSourceEvery", params)
            : intl.get("app.cleanupPreviewSource", params)
    }

    function toggleProxy() {
        window.settings.toggleProxyStatus()
        setPacStatus(window.settings.getProxyStatus())
        setPacUrl(window.settings.getProxy())
    }

    function setProxy(event: React.FormEvent) {
        event.preventDefault()
        if (validPacUrl) window.settings.setProxy(pacUrl)
    }

    function confirmDelete() {
        const preview = cleanupPreview
        // Only the filter of the preview currently shown may be deleted.
        if (
            deletingRef.current ||
            !preview ||
            preview.seq !== cleanupSeq.current ||
            !(preview.count > 0)
        )
            return
        deletingRef.current = true
        setDeleting(true)
        setItemSize(null)
        setCleanupMessage(null)
        deleteArticles(preview.filter)
            .then(
                result => {
                    if (!mounted.current) return
                    setCleanupMessage(cleanupResultMessage(result))
                },
                err => {
                    console.error(err)
                    if (!mounted.current) return
                    setCleanupMessage(
                        intl.get("app.cleanupFailed", {
                            error: cleanupError(err),
                        })
                    )
                }
            )
            .finally(() => {
                deletingRef.current = false
                if (!mounted.current) return
                setDeleting(false)
                setPreviewRequest(n => n + 1)
                calculateItemSize().then(size => {
                    if (mounted.current) setItemSize(byteToMB(size))
                })
            })
    }

    async function clearCache() {
        await window.utils.clearCache()
        setCacheSize(byteToMB(await window.utils.getCacheSize()))
    }

    const summary = cleanupSummary()

    return (
        <div className={mergeClasses("tab-body", classes.root)}>
            <Field label={intl.get("app.language")}>
                <Dropdown
                    inlinePopup
                    className={classes.dropdown}
                    selectedOptions={[locale]}
                    value={
                        languageOptions.find(option => option.value === locale)
                            ?.text || ""
                    }
                    onOptionSelect={(_, data) => {
                        if (!data.optionValue) return
                        setLocale(data.optionValue)
                        setLanguage(data.optionValue)
                    }}>
                    {languageOptions.map(option => (
                        <Option key={option.value} value={option.value}>
                            {option.text}
                        </Option>
                    ))}
                </Dropdown>
            </Field>

            <Field label={intl.get("app.theme")}>
                <RadioGroup
                    value={theme}
                    onChange={(_, data) => {
                        const value = data.value as ThemeSettings
                        setThemeSettings(value)
                        setTheme(value)
                    }}>
                    <Radio
                        value={ThemeSettings.Default}
                        label={intl.get("followSystem")}
                    />
                    <Radio
                        value={ThemeSettings.Light}
                        label={intl.get("app.lightTheme")}
                    />
                    <Radio
                        value={ThemeSettings.Dark}
                        label={intl.get("app.darkTheme")}
                    />
                </RadioGroup>
            </Field>

            <Field label={intl.get("app.fetchInterval")}>
                <Dropdown
                    inlinePopup
                    className={classes.dropdown}
                    selectedOptions={[fetchInterval]}
                    value={
                        fetchIntervalOptions.find(
                            option => option.value === fetchInterval
                        )?.text || ""
                    }
                    onOptionSelect={(_, data) => {
                        if (!data.optionValue) return
                        setSelectedFetchInterval(data.optionValue)
                        setFetchInterval(Number(data.optionValue))
                    }}>
                    {fetchIntervalOptions.map(option => (
                        <Option key={option.value} value={option.value}>
                            {option.text}
                        </Option>
                    ))}
                </Dropdown>
            </Field>

            <Field label={intl.get("searchEngine.name")}>
                <Dropdown
                    inlinePopup
                    className={classes.dropdown}
                    selectedOptions={[String(searchEngine)]}
                    value={getSearchEngineName(searchEngine)}
                    onOptionSelect={(_, data) => {
                        if (!data.optionValue) return
                        const value = Number(data.optionValue)
                        setSearchEngine(value)
                        window.settings.setSearchEngine(value)
                    }}>
                    {searchEngineOptions.map(engine => (
                        <Option key={engine} value={String(engine)}>
                            {getSearchEngineName(engine)}
                        </Option>
                    ))}
                </Dropdown>
            </Field>

            <Field
                className={classes.proxy}
                orientation="horizontal"
                label={intl.get("app.enableProxy")}>
                <Switch checked={pacStatus} onChange={toggleProxy} />
            </Field>
            {pacStatus && (
                <form onSubmit={setProxy}>
                    <Field
                        validationState={pacError ? "error" : "none"}
                        validationMessage={pacError}
                        hint={intl.get("app.pacHint")}>
                        <div className={classes.row}>
                            <Input
                                required
                                className={classes.grow}
                                aria-label={intl.get("app.pac")}
                                placeholder={intl.get("app.pac")}
                                name="pacUrl"
                                value={pacUrl}
                                onChange={(_, data) =>
                                    setPacUrl(data.value.trim())
                                }
                            />
                            <Button disabled={!validPacUrl} type="submit">
                                {intl.get("app.setPac")}
                            </Button>
                        </div>
                    </Field>
                </form>
            )}

            <div className={classes.section}>
                <Field label={intl.get("app.cleanup")}>
                    <RadioGroup
                        value={cleanupScope}
                        disabled={cleanupLocked}
                        onChange={(_, data) =>
                            selectCleanup({
                                cleanupScope: data.value as CleanupScope,
                            })
                        }>
                        <Radio
                            value="all"
                            label={intl.get("app.cleanupAllSources")}
                        />
                        <Radio
                            value="source"
                            label={intl.get("app.cleanupOneSource")}
                        />
                        <Radio
                            value="group"
                            label={intl.get("app.cleanupOneGroup")}
                        />
                    </RadioGroup>
                </Field>
                {cleanupScope === "source" && (
                    <div className={classes.row}>
                        <Dropdown
                            inlinePopup
                            className={mergeClasses(
                                classes.grow,
                                classes.cleanup
                            )}
                            aria-label={intl.get("app.cleanupSelectSource")}
                            placeholder={intl.get("app.cleanupSelectSource")}
                            selectedOptions={
                                cleanupSid === null ? [] : [String(cleanupSid)]
                            }
                            value={
                                sourceOptions.find(o => o.id === cleanupSid)
                                    ?.text || ""
                            }
                            disabled={cleanupLocked}
                            onOptionSelect={(_, data) =>
                                selectCleanup({
                                    cleanupSid: data.optionValue
                                        ? Number(data.optionValue)
                                        : null,
                                })
                            }>
                            {sourceOptions.map(option => (
                                <Option key={option.value} value={option.value}>
                                    {option.text}
                                </Option>
                            ))}
                        </Dropdown>
                    </div>
                )}
                {cleanupScope === "group" && (
                    <div className={classes.row}>
                        <Dropdown
                            inlinePopup
                            className={mergeClasses(
                                classes.grow,
                                classes.cleanup
                            )}
                            aria-label={intl.get("app.cleanupSelectGroup")}
                            placeholder={intl.get("app.cleanupSelectGroup")}
                            selectedOptions={
                                cleanupGid === null ? [] : [String(cleanupGid)]
                            }
                            value={
                                groupOptions.find(o => o.id === cleanupGid)
                                    ?.text || ""
                            }
                            disabled={cleanupLocked}
                            onOptionSelect={(_, data) =>
                                selectCleanup({
                                    cleanupGid: data.optionValue
                                        ? Number(data.optionValue)
                                        : null,
                                })
                            }>
                            {groupOptions.map(option => (
                                <Option key={option.value} value={option.value}>
                                    {option.text}
                                </Option>
                            ))}
                        </Dropdown>
                    </div>
                )}
                <div className={classes.row}>
                    <Dropdown
                        inlinePopup
                        className={mergeClasses(classes.grow, classes.cleanup)}
                        aria-label={intl.get("app.deleteChoices")}
                        placeholder={intl.get("app.deleteChoices")}
                        selectedOptions={
                            deleteIndex === null ? [] : [deleteIndex]
                        }
                        value={
                            deleteOptions.find(
                                option => option.value === deleteIndex
                            )?.text || ""
                        }
                        disabled={cleanupLocked}
                        onOptionSelect={(_, data) =>
                            selectCleanup({
                                deleteIndex: data.optionValue ?? null,
                            })
                        }>
                        {deleteOptions.map(option => (
                            <Option key={option.value} value={option.value}>
                                {option.text}
                            </Option>
                        ))}
                    </Dropdown>
                    <DangerButton
                        key={cleanupPreview?.seq ?? -1}
                        disabled={deleting || !(cleanupPreview?.count > 0)}
                        text={intl.get("app.confirmDelete")}
                        onClick={confirmDelete}
                    />
                </div>
                {cleanupMessage && (
                    <Text size={200} className={classes.hint}>
                        {cleanupMessage}
                    </Text>
                )}
                {summary && (
                    <Text size={200} className={classes.hint}>
                        {summary}
                    </Text>
                )}
                <Text size={200} className={classes.hint}>
                    {itemSize
                        ? intl.get("app.itemSize", { size: itemSize })
                        : intl.get("app.calculatingSize")}
                </Text>
            </div>
            <div className={classes.section}>
                <div className={classes.row}>
                    <Button
                        disabled={cacheSize === null || cacheSize === "0MB"}
                        onClick={clearCache}>
                        {intl.get("app.cache")}
                    </Button>
                </div>
                <Text size={200} className={classes.hint}>
                    {cacheSize
                        ? intl.get("app.cacheSize", { size: cacheSize })
                        : intl.get("app.calculatingSize")}
                </Text>
            </div>

            <div className={classes.section}>
                <Text weight="semibold">{intl.get("app.data")}</Text>
                <div className={classes.row}>
                    <Button appearance="primary" onClick={exportAll}>
                        {intl.get("app.backup")}
                    </Button>
                    <Button onClick={importAll}>
                        {intl.get("app.restore")}
                    </Button>
                </div>
            </div>
        </div>
    )
}

export default AppTab
