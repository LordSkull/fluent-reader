// Electron main process of the keyboard test: one window on a temporary
// profile and an in-memory session, showing only the bundled test page.
// Keys are sent as trusted input events (webContents.sendInputEvent).
const { app, BrowserWindow } = require("electron")
const path = require("node:path")

const dir = process.env.FR_KBD_DIR
if (!dir) throw new Error("FR_KBD_DIR is required")
// Before ready: nothing is written to the default profile.
app.setPath("userData", path.join(dir, "profile"))
app.setPath("sessionData", path.join(dir, "profile"))
app.disableHardwareAcceleration()

const results = []
let failed = 0
function check(name, ok, detail) {
    results.push({ name, ok: Boolean(ok), detail })
    if (!ok) failed++
    console.log(
        `${ok ? "ok    " : "FAIL  "} ${name}${
            ok ? "" : "  " + JSON.stringify(detail)
        }`
    )
}
const wait = ms => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: process.env.FR_KBD_SHOW === "1",
        width: 900,
        height: 700,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            partition: "fr-keyboard-test",
            backgroundThrottling: false,
        },
    })
    win.webContents.on("console-message", e => {
        if (e.level === "error") console.log("[page]", e.message)
    })
    const js = code => win.webContents.executeJavaScript(code)
    const t = expr => js(`window.__test.${expr}`)
    async function press(keyCode, modifiers = []) {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers })
        // As a keyboard does: Enter also types a carriage return, which
        // activates a focused button.
        const char = keyCode === "Enter" ? String.fromCharCode(13) : keyCode
        if (char.length === 1)
            win.webContents.sendInputEvent({
                type: "char",
                keyCode: char,
                modifiers,
            })
        win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers })
        await wait(200)
    }
    async function click(x, y) {
        for (const type of ["mouseDown", "mouseUp"])
            win.webContents.sendInputEvent({
                type,
                x,
                y,
                button: "left",
                clickCount: 1,
            })
        await wait(300)
    }
    async function downTo(prefix, limit = 15) {
        for (let i = 0; i < limit; i++) {
            if ((await t("describe()")).startsWith(prefix)) return true
            await press("Down")
        }
        return (await t("describe()")).startsWith(prefix)
    }

    try {
        await win.loadFile(path.join(dir, "page.html"))
        for (let i = 0; i < 100 && !(await js("window.__ready === true")); i++)
            await wait(100)
        win.webContents.focus()
        await wait(200)
        const [rep, copy2, copy3, single, rep2, copy22] = await t("ids")
        check("page focused", await t("hasFocus()"))
        let s = await t("state()")
        check(
            "three entries for six articles",
            JSON.stringify(s.visible) === JSON.stringify([rep, single, rep2]),
            s.visible
        )

        // Semantics of the badge.
        const badge = await t(`badge(${rep})`)
        check(
            "badge is a button with a popup",
            badge &&
                badge.tag === "button" &&
                badge.type === "button" &&
                badge.haspopup === "menu" &&
                badge.expanded === "false",
            badge
        )
        check(
            "badge accessible name",
            badge &&
                badge.label === "3 copies from different sources" &&
                badge.text === "×3",
            badge
        )
        check(
            "badge outside arrow navigation",
            badge && badge.tabIndex === -1 && badge.focusable === "false",
            badge
        )
        check("no badge without copies", (await t(`badge(${single})`)) === null)

        // Arrow keys move between cards only.
        check(
            "focus first card",
            (await t(`focusCard(${rep})`)) === `card:${rep}`
        )
        const path1 = []
        for (const key of ["Down", "Down", "Up", "Up"]) {
            await press(key)
            path1.push(await t("describe()"))
        }
        check(
            "arrows go card to card, never to the badge or hidden copies",
            JSON.stringify(path1) ===
                JSON.stringify([
                    `card:${single}`,
                    `card:${rep2}`,
                    `card:${single}`,
                    `card:${rep}`,
                ]),
            path1
        )

        // Shift+F10 opens the item menu without activating the card.
        await press("F10", ["shift"])
        s = await t("state()")
        check(
            "Shift+F10 opens the menu of the focused card",
            s.menus === 1 && s.menuItem === rep,
            s
        )
        check(
            "focus moves into the menu",
            (await t("describe()")).startsWith("menu:"),
            await t("describe()")
        )
        check(
            "the card is not activated",
            s.itemId === null && s.writes.length === 0,
            s
        )
        check(
            "menu lists the copies entry",
            s.menuTexts[0].some(x => x.startsWith("Copies (3)")),
            s.menuTexts
        )
        check(
            "arrows reach the copies entry",
            await downTo("menu:Copies (3)"),
            await t("describe()")
        )
        const roles = await t("roles()")
        check(
            "copies entry announces a submenu",
            roles.some(
                ([role, name, , popup]) =>
                    role === "menuitem" &&
                    name.startsWith("Copies (3)") &&
                    popup === "true"
            ),
            roles
        )

        await press("Right")
        s = await t("state()")
        check("Right opens the submenu of copies", s.menus === 2, s)
        check(
            "focus on the first copy",
            (await t("describe()")).startsWith("menu:ANSA Lombardia"),
            await t("describe()")
        )
        const subRoles = (await t("roles()")).filter(
            ([role]) => role === "menuitemcheckbox"
        )
        check(
            "each copy is a named menu item",
            subRoles.length === 3 &&
                ["ANSA Lombardia", "ANSA Veneto", "ANSA Emilia-Romagna"].every(
                    (n, i) => subRoles[i][1].startsWith(n)
                ),
            subRoles
        )

        await press("Escape")
        s = await t("state()")
        check(
            "Escape closes the submenu only",
            s.menus === 1 &&
                (await t("describe()")).startsWith("menu:Copies (3)"),
            [s.menus, await t("describe()")]
        )

        await press("Right")
        await press("Down")
        check(
            "Down moves to the second copy",
            (await t("describe()")).startsWith("menu:ANSA Veneto"),
            await t("describe()")
        )
        await press("Enter")
        await wait(300)
        s = await t("state()")
        check("Enter opens that copy", s.itemId === copy2, s)
        check(
            "only that copy is read",
            JSON.stringify(s.read) ===
                JSON.stringify([false, true, false, false, false, false]),
            s.read
        )
        check(
            "one write, for that copy",
            s.writes.length === 1 && s.writes[0].params.includes(copy2),
            s.writes
        )
        check("menus closed", s.menus === 0, s)
        check(
            "focus back on the card",
            (await t("describe()")) === `card:${rep}`,
            await t("describe()")
        )

        // Escape closes the menu and restores the focus.
        await t(`focusCard(${single})`)
        await press("F10", ["shift"])
        s = await t("state()")
        check(
            "menu of a card without copies has no copies entry",
            s.menus === 1 && !s.menuTexts[0].some(x => x.startsWith("Copies")),
            s.menuTexts
        )
        await press("Escape")
        await wait(200)
        s = await t("state()")
        check("Escape closes the menu", s.menus === 0, s)
        check(
            "focus restored to the card",
            (await t("describe()")) === `card:${single}`,
            await t("describe()")
        )

        // The Menu key, where the platform sends one.
        await t(`focusCard(${rep2})`)
        await js("window.__test.keys.length = 0")
        await press("Apps")
        let keys = await t("keys")
        s = await t("state()")
        if (keys.includes("ContextMenu")) {
            check(
                "Menu key opens the menu",
                s.menus === 1 && s.menuItem === rep2,
                s
            )
        } else {
            // sendInputEvent has no Menu key here: send the key event the
            // card receives from it.
            await js(
                `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }))`
            )
            await wait(300)
            s = await t("state()")
            check(
                "Menu key (synthetic keydown) opens the menu",
                s.menus === 1 && s.menuItem === rep2,
                { s, keys }
            )
        }
        await press("Escape")
        await wait(200)
        check(
            "focus restored after the Menu key",
            (await t("describe()")) === `card:${rep2}`,
            await t("describe()")
        )

        // Existing shortcuts and modifiers.
        await t(`focusCard(${single})`)
        const before = (await t("state()")).writes.length
        await press("F10", ["shift", "control"])
        s = await t("state()")
        check("Ctrl+Shift+F10 does not open the menu", s.menus === 0, s)
        await press("s")
        await press("m")
        s = await t("state()")
        check(
            "shortcuts s and m still act on the focused card",
            s.starred[3] === true &&
                s.read[3] === true &&
                s.writes.length === before + 2,
            s
        )
        check(
            "the focus stays on the card",
            (await t("describe()")) === `card:${single}`,
            await t("describe()")
        )

        // The badge with the mouse, then the keyboard in its menu.
        await t(`focusCard(${rep2})`)
        const b2 = await t(`badge(${rep2})`)
        const itemBefore = (await t("state()")).itemId
        await click(b2.x, b2.y)
        s = await t("state()")
        check(
            "badge click opens the list of copies",
            s.menus === 1 && s.menuType === 0,
            s
        )
        check(
            "badge click does not activate the card",
            s.itemId === itemBefore,
            s
        )
        check(
            "badge reports the open menu",
            (await t(`badge(${rep2})`)).expanded === "true"
        )
        check(
            "focus moves into the list",
            (await t("describe()")).startsWith("menu:"),
            await t("describe()")
        )
        check(
            "arrows reach the second copy",
            await downTo("menu:ANSA Emilia-Romagna"),
            await t("describe()")
        )
        await press("Enter")
        await wait(300)
        s = await t("state()")
        check(
            "Enter opens that copy only",
            s.itemId === copy22 &&
                s.read[5] === true &&
                s.read[4] === false &&
                s.menus === 0,
            s
        )
        check(
            "focus back on the card after the badge menu",
            (await t("describe()")) === `card:${rep2}`,
            await t("describe()")
        )

        await t(`focusCard(${rep})`)
        const b1 = await t(`badge(${rep})`)
        await click(b1.x, b1.y)
        await press("Escape")
        await wait(200)
        s = await t("state()")
        check(
            "Escape closes the badge menu",
            s.menus === 0 && (await t(`badge(${rep})`)).expanded === "false",
            s
        )
        check(
            "focus back on the card after Escape",
            (await t("describe()")) === `card:${rep}`,
            await t("describe()")
        )
        check(
            "no copy opened by the badge menu tests except the chosen ones",
            JSON.stringify(s.read) ===
                JSON.stringify([false, true, false, true, false, true]),
            s.read
        )
    } catch (err) {
        check("no exception", false, String(err && err.stack))
    }
    console.log(
        `# keyboard: ${results.length - failed}/${results.length} passed`
    )
    app.exit(failed ? 1 : 0)
})
