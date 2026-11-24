# Tests

This directory holds three kinds of tests. Keep them apart.

| Directory | What | Tracked here |
|---|---|---|
| `tests/e2e` | Private upstream end-to-end tests (git submodule) | Only the submodule pointer |
| `tests/fork` | Public tests specific to this fork, on synthetic data | Yes |
| `tests/main` | Optional local tests, excluded from Git | No |

## `tests/e2e`: private upstream end-to-end tests

The optional `e2e` submodule is maintained in the private
`yang991178/fluent-reader-tests` repository. Normal installs, builds, and release
workflows do not need it. Recursive clones require access to that repository.

From the application repository root:

```sh
git submodule update --init tests/e2e
npm install
npm run build
npm --prefix tests/e2e ci
npm --prefix tests/e2e test
```

See `tests/e2e/README.md` for the harness architecture and diagnostics. Commit
and push test changes in the private repository before publishing an updated
submodule pointer here. Never add the sources or reports of these private
tests directly to this public repository.

## `tests/fork`: public tests of this fork

These tests cover features of this fork. They are public and use only
synthetic data, temporary in-memory databases and temporary profiles. They
need only the files tracked in this repository and the packages that a normal
`npm install` (or `npm ci`) installs, `electron` and `esbuild` included. They
never read personal data, a real profile, the network or `tests/main`.

Each runner finds the repository root from its own location, so no absolute
path is involved.

### `cross-source-duplicates`

This directory tests copies of the same article across RSS sources
(`src/scripts/duplicates.ts`). The conformance cases are read from the public
contract, `contracts/cross-source-duplicates/conformance.json` (`../../..`
from the suite). Do not copy them here.

From the repository root (no build needed):

```sh
npm install
npm run test:duplicates            # identity, contract, grouping, feeds
npm run test:duplicates:keyboard   # keyboard and accessibility, in Electron
```

- `run.js` bundles `suite.ts` with esbuild and runs it with Electron's Node
  runtime (`ELECTRON_RUN_AS_NODE`), because `better-sqlite3` loads its
  Node-API prebuild there as in the app. `setup.ts` provides an in-memory
  SQLite database with the migrations of `dist/drizzle` and stubbed bridges.
- `keyboard/run.js` bundles the real list feed, cards and context menu into a
  page and opens it in one hidden Electron window. The window uses a
  temporary profile, which is always deleted, an in-memory session and a
  stubbed database. Keys are trusted input events (`sendInputEvent`). Set
  `FR_KBD_SHOW=1` to see the window.

### `article-full-content`

This directory tests "Load full content" on synthetic fixtures with invented
text (`fixtures/`), never on a live site.

```sh
npm install
npm run test:full-content
```

- `main.js` opens the real `dist/article/article.html`, with its CSP and SRI,
  in a hidden Electron window and gives it each fixture as the article
  webview receives it: an Ars Technica article in several blocks, an
  unrecognized and a paginated Ars page, ANSA, another domain and RSS mode.
  It checks the text, the allowed elements, attributes and links, the
  incompleteness notice, and that no page script runs. Every request that is
  not a local file is blocked, and none may happen.
- `hook-page.tsx` mounts the real `useArticleView` hook with stubbed bridges
  (`stubs.ts`) and a stubbed `fetch`: HTTP 403 is an error, HTTP 200 passes
  the whole page on, RSS mode makes no request, and nothing is written.
- The windows use a temporary profile, which is always deleted, and
  in-memory sessions.

## `tests/main`: local tests

`tests/main` may hold local, machine-specific tests. It is excluded through
`.git/info/exclude` and is never published. No public test may depend on it.
