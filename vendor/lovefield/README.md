# Lovefield browser bundle

`lovefield.min.js` is the unmodified browser bundle of
[Lovefield](https://github.com/google/lovefield) 2.1.12. The renderer only
needs it to migrate profiles from the legacy Lovefield IndexedDB databases
(`sourcesDB`, `itemsDB`) to SQLite in `src/scripts/db.ts`. `webpack.config.js`
resolves `import lf from "lovefield"` to this file, and type definitions come
from `@types/lovefield`.

The npm package is not a dependency: its Node-only schema compiler pulls in
`js-yaml@3.1.0`, `argparse@0.1.16`, `underscore@1.7.0` and
`underscore.string@2.4.0`, none of which are part of the browser bundle.

## Provenance

| Field | Value |
|---|---|
| Package | `lovefield@2.1.12` (last release, 2017-02-04) |
| Tarball | `https://registry.npmjs.org/lovefield/-/lovefield-2.1.12.tgz` |
| Tarball `dist.integrity` | `sha512-uOTF9enxl7bhyGtsWMkQTeWLpaNuJ0N0d5wH2/r6upQ3pvBEKEsiix+pwo8FHlli3SmDbrvuXo6a+HD7An99OQ==` |
| Tarball `dist.shasum` | `07fb9f1d7840578ec784706cad0fbe7de4c93f52` |
| Upstream `gitHead` | `bd1232ea63a94d87116330d99abda3ada391fe60` |
| Source file | `package/dist/lovefield.min.js` |
| `lovefield.min.js` SHA-256 | `29d915a5f87c56a3eb900c2a144eb981c8eda7430bd62bd3dd3219f435e73617` |
| License | Apache-2.0, `LICENSE` copied unmodified from `package/LICENSE` |

The package ships no `NOTICE` file. The bundle keeps its upstream copyright
headers. `.gitattributes` pins LF line endings so checkouts stay byte-identical.

## Updating

Lovefield is unmaintained, so this file is not expected to change. If it must,
do it as a reviewed change:

1. `npm view lovefield@<version> dist.tarball dist.integrity gitHead`
2. In a temporary directory, `npm pack lovefield@<version>` and check that the
   tarball's SHA-512 equals `dist.integrity`.
3. Copy `package/dist/lovefield.min.js` and `package/LICENSE` over the files
   here without reformatting them.
4. Update the table above, including the new SHA-256.
5. Check that `@types/lovefield` still matches the API used in
   `src/scripts/db.ts`, run `npm run build`, and test a migration from a
   synthetic legacy profile.
