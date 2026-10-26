import { connect } from "react-redux"
import {
    initIntl,
    saveSettings,
    setupAutoFetch,
} from "../../scripts/models/app"
import AppTab from "../../components/settings/app"
import { importAll } from "../../scripts/settings"
import {
    CleanupFilter,
    countArticles,
    deleteArticles,
} from "../../scripts/cleanup"
import { AppDispatch } from "../../scripts/utils"
import { RootState } from "../../scripts/reducer"

const mapStateToProps = (state: RootState) => ({
    sources: state.sources,
})

const mapDispatchToProps = (dispatch: AppDispatch) => ({
    setLanguage: (option: string) => {
        window.settings.setLocaleSettings(option)
        dispatch(initIntl())
    },
    setFetchInterval: (interval: number) => {
        window.settings.setFetchInterval(interval)
        dispatch(setupAutoFetch())
    },
    countArticles: (filter: CleanupFilter) => dispatch(countArticles(filter)),
    deleteArticles: (filter: CleanupFilter) => dispatch(deleteArticles(filter)),
    importAll: async () => {
        dispatch(saveSettings())
        let cancelled = await importAll()
        if (cancelled) dispatch(saveSettings())
    },
})

const AppTabContainer = connect(mapStateToProps, mapDispatchToProps)(AppTab)
export default AppTabContainer
