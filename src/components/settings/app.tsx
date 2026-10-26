import * as React from "react"
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
    Stack,
    Label,
    Toggle,
    TextField,
    DefaultButton,
    Dropdown,
    IDropdownOption,
    PrimaryButton,
} from "@fluentui/react"
import { RadioGroup, Radio } from "@fluentui/react-components"
import DangerButton from "../utils/danger-button"
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

type AppTabState = CleanupSelection & {
    pacStatus: boolean
    pacUrl: string
    themeSettings: ThemeSettings
    itemSize: string
    cacheSize: string
    cleanupPreview: CleanupPreview
    cleanupMessage: string
    deleting: boolean
}

class AppTab extends React.Component<AppTabProps, AppTabState> {
    constructor(props) {
        super(props)
        this.state = {
            pacStatus: window.settings.getProxyStatus(),
            pacUrl: window.settings.getProxy(),
            themeSettings: getThemeSettings(),
            itemSize: null,
            cacheSize: null,
            deleteIndex: null,
            cleanupScope: "all",
            cleanupSid: null,
            cleanupGid: null,
            cleanupPreview: null,
            cleanupMessage: null,
            deleting: false,
        }
        this.getItemSize()
        this.getCacheSize()
    }

    getCacheSize = () => {
        window.utils.getCacheSize().then(size => {
            this.setState({ cacheSize: byteToMB(size) })
        })
    }
    getItemSize = () => {
        calculateItemSize().then(size => {
            this.setState({ itemSize: byteToMB(size) })
        })
    }

    clearCache = () => {
        window.utils.clearCache().then(() => {
            this.getCacheSize()
        })
    }

    fetchIntervalOptions = (): IDropdownOption[] => [
        { key: 0, text: intl.get("app.never") },
        { key: 10, text: intl.get("time.minute", { m: 10 }) },
        { key: 15, text: intl.get("time.minute", { m: 15 }) },
        { key: 20, text: intl.get("time.minute", { m: 20 }) },
        { key: 30, text: intl.get("time.minute", { m: 30 }) },
        { key: 45, text: intl.get("time.minute", { m: 45 }) },
        { key: 60, text: intl.get("time.hour", { h: 1 }) },
    ]
    onFetchIntervalChanged = (item: IDropdownOption) => {
        this.props.setFetchInterval(item.key as number)
    }

    searchEngineOptions = (): IDropdownOption[] =>
        [
            SearchEngines.Google,
            SearchEngines.Bing,
            SearchEngines.Baidu,
            SearchEngines.DuckDuckGo,
        ].map(engine => ({
            key: engine,
            text: getSearchEngineName(engine),
        }))
    onSearchEngineChanged = (item: IDropdownOption) => {
        window.settings.setSearchEngine(item.key as number)
    }

    deleteOptions = (): IDropdownOption[] =>
        CLEANUP_PERIODS.map(days => ({
            key: String(days),
            text:
                days === 0
                    ? intl.get("app.deleteAll")
                    : intl.get("app.daysAgo", { days: days }),
        }))

    // Sorted by name; duplicate names are told apart by their URL.
    cleanupSourceOptions = (): IDropdownOption[] => {
        const sources = Object.values(this.props.sources).sort(
            (a, b) => a.name.localeCompare(b.name) || a.sid - b.sid
        )
        const names = new Map<string, number>()
        for (let source of sources)
            names.set(source.name, (names.get(source.name) || 0) + 1)
        return sources.map(source => ({
            key: source.sid,
            text:
                names.get(source.name) > 1
                    ? `${source.name} (${source.url})`
                    : source.name,
        }))
    }

    // User groups only, keyed by gid and sorted by name; duplicate names are
    // numbered in the order the groups were created.
    cleanupGroupOptions = (): IDropdownOption[] => {
        const groups = this.props.groups
            .filter(group => group.isMultiple === true)
            .sort(
                (a, b) =>
                    String(a.name).localeCompare(String(b.name)) ||
                    a.gid - b.gid
            )
        const names = new Map<string, number>()
        for (let group of groups)
            names.set(group.name, (names.get(group.name) || 0) + 1)
        const numbers = new Map<string, number>()
        return groups.map(group => {
            const n = (numbers.get(group.name) || 0) + 1
            numbers.set(group.name, n)
            return {
                key: group.gid,
                text:
                    names.get(group.name) > 1
                        ? `${group.name} (${n})`
                        : group.name,
            }
        })
    }

    // Each selection gets a new sequence number. Counts of older selections
    // are discarded, and the DangerButton is keyed by it so that a pending
    // confirmation never carries over to another selection.
    cleanupSeq = 0
    deleting = false
    unmounted = false

    componentWillUnmount() {
        this.unmounted = true
        // Discards the pending count.
        this.cleanupSeq++
    }

    updateCleanupPreview = () => {
        const seq = ++this.cleanupSeq
        const { deleteIndex, cleanupScope, cleanupSid, cleanupGid } = this.state
        const filter =
            deleteIndex === null
                ? null
                : makeCleanupFilter(
                      parseInt(deleteIndex),
                      cleanupScope,
                      cleanupScope === "group" ? cleanupGid : cleanupSid,
                      this.props.sources,
                      Date.now(),
                      this.props.groups
                  )
        if (filter === null) {
            this.setState({ cleanupPreview: null })
            return
        }
        this.setState({ cleanupPreview: { seq: seq, filter: filter } })
        const setCount = (count: number, failed = false) => {
            if (seq !== this.cleanupSeq) return
            this.setState(state =>
                state.cleanupPreview?.seq === seq
                    ? {
                          cleanupPreview: {
                              ...state.cleanupPreview,
                              count: count,
                              failed: failed,
                          },
                      }
                    : null
            )
        }
        this.props.countArticles(filter).then(
            count => setCount(count),
            err => {
                console.error(err)
                setCount(undefined, true)
            }
        )
    }

    selectCleanup = (selection: Partial<CleanupSelection>) => {
        this.setState(
            {
                deleteIndex: this.state.deleteIndex,
                cleanupScope: this.state.cleanupScope,
                cleanupSid: this.state.cleanupSid,
                cleanupGid: this.state.cleanupGid,
                ...selection,
                cleanupMessage: null,
            },
            this.updateCleanupPreview
        )
    }

    deleteChange = (_, item: IDropdownOption) => {
        this.selectCleanup({ deleteIndex: item ? String(item.key) : null })
    }

    cleanupScopeChange = (
        _: React.FormEvent<HTMLDivElement>,
        data: { value: string }
    ) => {
        this.selectCleanup({ cleanupScope: data.value as CleanupScope })
    }

    cleanupSourceChange = (_, item: IDropdownOption) => {
        this.selectCleanup({ cleanupSid: item ? (item.key as number) : null })
    }

    cleanupGroupChange = (_, item: IDropdownOption) => {
        this.selectCleanup({ cleanupGid: item ? (item.key as number) : null })
    }

    componentDidUpdate(prevProps: AppTabProps) {
        const sid = this.state.cleanupSid
        if (
            prevProps.sources !== this.props.sources &&
            sid !== null &&
            !(sid in this.props.sources)
        ) {
            this.selectCleanup({ cleanupSid: null })
        }
        const gid = this.state.cleanupGid
        if (prevProps.groups !== this.props.groups && gid !== null) {
            const find = (groups: SourceGroup[]) =>
                groups.find(g => g.isMultiple === true && g.gid === gid)
            // Compared as sets: reordering the sources changes nothing.
            const members = (group: SourceGroup) =>
                group ? [...new Set(group.sids)].sort().join() : null
            const group = find(this.props.groups)
            if (!group) {
                this.selectCleanup({ cleanupGid: null })
            } else if (
                this.state.cleanupScope === "group" &&
                members(group) !== members(find(prevProps.groups))
            ) {
                // Replaces the preview and any pending confirmation.
                this.selectCleanup({})
            }
        }
    }

    // The selection is locked while deleting and while counting it.
    cleanupLocked = () => {
        const preview = this.state.cleanupPreview
        return (
            this.state.deleting ||
            (preview !== null && preview.count === undefined && !preview.failed)
        )
    }

    cleanupSummary = (): string => {
        if (this.state.deleting) return intl.get("app.cleanupDeleting")
        const preview = this.state.cleanupPreview
        if (preview === null) {
            const { cleanupScope, cleanupGid, deleteIndex } = this.state
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
            const option = this.cleanupGroupOptions().find(o => o.key === gid)
            const params = {
                count: preview.count,
                days: days,
                name: option ? option.text : String(gid),
            }
            return days === 0
                ? intl.get("app.cleanupPreviewGroupEvery", params)
                : intl.get("app.cleanupPreviewGroup", params)
        }
        const option = this.cleanupSourceOptions().find(o => o.key === sid)
        const params = {
            count: preview.count,
            days: days,
            name: option ? option.text : String(sid),
        }
        return days === 0
            ? intl.get("app.cleanupPreviewSourceEvery", params)
            : intl.get("app.cleanupPreviewSource", params)
    }

    // Drizzle wraps database errors; the cause carries the actual reason.
    cleanupError = (err: unknown) =>
        String(err instanceof Error && err.cause ? err.cause : err)

    cleanupResultMessage = (result: CleanupResult) => {
        if (result.vacuumError)
            return intl.get("app.cleanupVacuumFailed", {
                count: result.deleted,
                error: this.cleanupError(result.vacuumError),
            })
        if (result.refreshError)
            return intl.get("app.cleanupRefreshFailed", {
                count: result.deleted,
                error: this.cleanupError(result.refreshError),
            })
        return intl.get("app.cleanupDone", { count: result.deleted })
    }

    confirmDelete = () => {
        const preview = this.state.cleanupPreview
        // Only the filter of the preview currently shown may be deleted.
        if (
            this.deleting ||
            !preview ||
            preview.seq !== this.cleanupSeq ||
            !(preview.count > 0)
        )
            return
        this.deleting = true
        this.setState({ deleting: true, itemSize: null, cleanupMessage: null })
        this.props
            .deleteArticles(preview.filter)
            .then(
                result => {
                    if (this.unmounted) return
                    this.setState({
                        cleanupMessage: this.cleanupResultMessage(result),
                    })
                },
                err => {
                    console.error(err)
                    if (this.unmounted) return
                    this.setState({
                        cleanupMessage: intl.get("app.cleanupFailed", {
                            error: this.cleanupError(err),
                        }),
                    })
                }
            )
            .finally(() => {
                this.deleting = false
                if (this.unmounted) return
                this.setState({ deleting: false }, this.updateCleanupPreview)
                this.getItemSize()
            })
    }

    languageOptions = (): IDropdownOption[] => [
        { key: "default", text: intl.get("followSystem") },
        { key: "de", text: "Deutsch" },
        { key: "en-US", text: "English" },
        { key: "es", text: "Español" },
        { key: "cs", text: "Čeština" },
        { key: "fr-FR", text: "Français" },
        { key: "it", text: "Italiano" },
        { key: "nl", text: "Nederlands" },
        { key: "pt-BR", text: "Português do Brasil" },
        { key: "pt-PT", text: "Português de Portugal" },
        { key: "fi-FI", text: "Suomi" },
        { key: "sv", text: "Svenska" },
        { key: "tr", text: "Türkçe" },
        { key: "uk", text: "Українська" },
        { key: "ru", text: "Русский" },
        { key: "ko", text: "한글" },
        { key: "ja", text: "日本語" },
        { key: "zh-CN", text: "中文（简体）" },
        { key: "zh-TW", text: "中文（繁體）" },
    ]

    toggleStatus = () => {
        window.settings.toggleProxyStatus()
        this.setState({
            pacStatus: window.settings.getProxyStatus(),
            pacUrl: window.settings.getProxy(),
        })
    }

    handleInputChange = event => {
        const name: string = event.target.name
        // @ts-ignore
        this.setState({ [name]: event.target.value.trim() })
    }

    setUrl = (event: React.FormEvent) => {
        event.preventDefault()
        if (urlTest(this.state.pacUrl))
            window.settings.setProxy(this.state.pacUrl)
    }

    onThemeChange = (
        _: React.ChangeEvent<HTMLInputElement>,
        data: { value: string }
    ) => {
        setThemeSettings(data.value as ThemeSettings)
        this.setState({ themeSettings: data.value as ThemeSettings })
    }

    render = () => (
        <div className="tab-body">
            <Label>{intl.get("app.language")}</Label>
            <Stack horizontal>
                <Stack.Item>
                    <Dropdown
                        defaultSelectedKey={window.settings.getLocaleSettings()}
                        options={this.languageOptions()}
                        onChanged={option =>
                            this.props.setLanguage(String(option.key))
                        }
                        style={{ width: 200 }}
                    />
                </Stack.Item>
            </Stack>

            <Label>{intl.get("app.theme")}</Label>
            <RadioGroup
                value={this.state.themeSettings}
                onChange={this.onThemeChange}>
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

            <Label>{intl.get("app.fetchInterval")}</Label>
            <Stack horizontal>
                <Stack.Item>
                    <Dropdown
                        defaultSelectedKey={window.settings.getFetchInterval()}
                        options={this.fetchIntervalOptions()}
                        onChanged={this.onFetchIntervalChanged}
                        style={{ width: 200 }}
                    />
                </Stack.Item>
            </Stack>

            <Label>{intl.get("searchEngine.name")}</Label>
            <Stack horizontal>
                <Stack.Item>
                    <Dropdown
                        defaultSelectedKey={window.settings.getSearchEngine()}
                        options={this.searchEngineOptions()}
                        onChanged={this.onSearchEngineChanged}
                        style={{ width: 200 }}
                    />
                </Stack.Item>
            </Stack>

            <Stack horizontal verticalAlign="baseline">
                <Stack.Item grow>
                    <Label>{intl.get("app.enableProxy")}</Label>
                </Stack.Item>
                <Stack.Item>
                    <Toggle
                        checked={this.state.pacStatus}
                        onChange={this.toggleStatus}
                    />
                </Stack.Item>
            </Stack>
            {this.state.pacStatus && (
                <form onSubmit={this.setUrl}>
                    <Stack horizontal>
                        <Stack.Item grow>
                            <TextField
                                required
                                onGetErrorMessage={v =>
                                    urlTest(v.trim())
                                        ? ""
                                        : intl.get("app.badUrl")
                                }
                                placeholder={intl.get("app.pac")}
                                name="pacUrl"
                                onChange={this.handleInputChange}
                                value={this.state.pacUrl}
                            />
                        </Stack.Item>
                        <Stack.Item>
                            <DefaultButton
                                disabled={!urlTest(this.state.pacUrl)}
                                type="sumbit"
                                text={intl.get("app.setPac")}
                            />
                        </Stack.Item>
                    </Stack>
                    <span className="settings-hint up">
                        {intl.get("app.pacHint")}
                    </span>
                </form>
            )}

            <Label>{intl.get("app.cleanup")}</Label>
            <RadioGroup
                value={this.state.cleanupScope}
                disabled={this.cleanupLocked()}
                onChange={this.cleanupScopeChange}>
                <Radio value="all" label={intl.get("app.cleanupAllSources")} />
                <Radio
                    value="source"
                    label={intl.get("app.cleanupOneSource")}
                />
                <Radio value="group" label={intl.get("app.cleanupOneGroup")} />
            </RadioGroup>
            {this.state.cleanupScope === "source" && (
                <Stack horizontal>
                    <Stack.Item grow>
                        <Dropdown
                            placeholder={intl.get("app.cleanupSelectSource")}
                            options={this.cleanupSourceOptions()}
                            selectedKey={this.state.cleanupSid}
                            disabled={this.cleanupLocked()}
                            onChange={this.cleanupSourceChange}
                        />
                    </Stack.Item>
                </Stack>
            )}
            {this.state.cleanupScope === "group" && (
                <Stack horizontal>
                    <Stack.Item grow>
                        <Dropdown
                            placeholder={intl.get("app.cleanupSelectGroup")}
                            options={this.cleanupGroupOptions()}
                            selectedKey={this.state.cleanupGid}
                            disabled={this.cleanupLocked()}
                            onChange={this.cleanupGroupChange}
                        />
                    </Stack.Item>
                </Stack>
            )}
            <Stack horizontal>
                <Stack.Item grow>
                    <Dropdown
                        placeholder={intl.get("app.deleteChoices")}
                        options={this.deleteOptions()}
                        selectedKey={this.state.deleteIndex}
                        disabled={this.cleanupLocked()}
                        onChange={this.deleteChange}
                    />
                </Stack.Item>
                <Stack.Item>
                    <DangerButton
                        key={this.state.cleanupPreview?.seq ?? -1}
                        disabled={
                            this.state.deleting ||
                            !(this.state.cleanupPreview?.count > 0)
                        }
                        text={intl.get("app.confirmDelete")}
                        onClick={this.confirmDelete}
                    />
                </Stack.Item>
            </Stack>
            {this.state.cleanupMessage && (
                <div className="settings-hint up">
                    {this.state.cleanupMessage}
                </div>
            )}
            {this.cleanupSummary() && (
                <div className="settings-hint up">{this.cleanupSummary()}</div>
            )}
            <span className="settings-hint up">
                {this.state.itemSize
                    ? intl.get("app.itemSize", { size: this.state.itemSize })
                    : intl.get("app.calculatingSize")}
            </span>
            <Stack horizontal>
                <Stack.Item>
                    <DefaultButton
                        text={intl.get("app.cache")}
                        disabled={
                            this.state.cacheSize === null ||
                            this.state.cacheSize === "0MB"
                        }
                        onClick={this.clearCache}
                    />
                </Stack.Item>
            </Stack>
            <span className="settings-hint up">
                {this.state.cacheSize
                    ? intl.get("app.cacheSize", { size: this.state.cacheSize })
                    : intl.get("app.calculatingSize")}
            </span>

            <Label>{intl.get("app.data")}</Label>
            <Stack horizontal>
                <Stack.Item>
                    <PrimaryButton
                        onClick={exportAll}
                        text={intl.get("app.backup")}
                    />
                </Stack.Item>
                <Stack.Item>
                    <DefaultButton
                        onClick={this.props.importAll}
                        text={intl.get("app.restore")}
                    />
                </Stack.Item>
            </Stack>
        </div>
    )
}

export default AppTab
