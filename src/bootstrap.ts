import { app } from "electron"

// Main-process entry. It must not import application modules: static imports
// run before this module's body, and those modules create the settings store
// and register IPC handlers as soon as they load. They are loaded only after
// this instance holds the single-instance lock (the Mac App Store build keeps
// skipping the lock, as before).
if (process.mas || app.requestSingleInstanceLock()) {
    require("./electron")
} else {
    app.quit()
}
