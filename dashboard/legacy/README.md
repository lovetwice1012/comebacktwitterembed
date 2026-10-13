This directory contains the actual live dashboard presentation captured before
the 2026-10-13 preview rollout. It comes from the authenticated production source
archive for release `02f26665277c5866c2ddb4309c1c9646f28c317b`, build
`bP2v88Nr8XVzXWJrmDlz2`. The archive SHA-256 is
`db08f056ebef96bb1f42be254dfc3427fe56ca3cbf8e3242cdce14bbb17ef14c`.
The server routes choose this presentation for accounts outside the new UI
rollout. It has no independent Next.js routes and makes no rollout decisions.

The copied modules retain their original exports and behavior. Imports between
copied presentation modules point into this directory, including the dynamic
admin console import. Every reachable presentation module is isolated, including
UI primitives and pure presentation helpers, so subsequent canonical UI changes
cannot affect the fallback implicitly. Authentication, sessions, Discord access
checks, databases, validation, catalog loading, data types/contracts and API
behavior remain canonical. The automation workspace is outside this versioned
presentation graph.

`legacy-manifest.json` records every snapshot source and generated output hash,
page export, rewritten dependency, and shared canonical dependency. The manifest
also identifies the production archive, revision, build and all 167 captured
source files. `production-source-manifest.json` records their SHA-256 hashes.
`globals-baseline.css` is the complete verified snapshot stylesheet; the root
stylesheet handles the rollout's scoped styles. It is a reference artifact and
should not be imported alongside the canonical globals stylesheet.

The snapshot captured the dashboard tree, not `admin-agent`. The actual live
presentation does not import `admin-agent/web/view-data`. Any future necessary
shared reference outside the captured tree is explicitly reported by the
manifest's `outsideSnapshotSharedDependencies` field.

To reproduce the copied graph from its recorded production snapshot, run:

```powershell
node dashboard/legacy/generate.cjs "C:/path/to/production-snapshot/source"
```

The verified production archive must be beside `source`, with its recorded
filename. The generator verifies its hash before writing, walks static, relative,
export and dynamic imports, and fails if a required captured dependency is
missing. It only writes within this directory and removes obsolete generated
files after validating that their resolved paths remain inside this directory.
To verify frozen output hashes, the captured source manifest, recorded source
hashes and import isolation on any checkout without the original capture, run:

```powershell
node dashboard/legacy/verify.cjs
```

This default command requires no Windows temporary directory or original source
archive. It reports `originalSourcesVerified: false`: the checked-in frozen files
and provenance records were verified, while the external original source bytes
were not read. The historical absolute paths in `legacy-manifest.json` remain
capture metadata and are not used as local verification inputs.

To additionally verify all 167 original files byte for byte, provide the source
tree containing `dashboard/`:

```powershell
node dashboard/legacy/verify.cjs --source-root "C:/path/to/production-snapshot/source" --require-original-sources
```

An explicit missing, incomplete or changed source tree fails verification. The
strict flag also fails when `--source-root` is omitted. A successful full check
reports `originalSourcesVerified: true` and `originalSourceFilesVerified: 167`.
Neither mode rewrites source files, presentation modules, or manifest hashes.

The three manual browser scripts (`scripts/verify-dashboard-redesign.cjs`,
`scripts/verify-dashboard-ui-rollout.cjs`, and
`scripts/verify-dashboard-ui-preference.cjs`) use `scripts/playwright-qa.cjs` to
resolve an already installed `playwright` or `playwright-core` package, with the
existing `design-previews/qa/node_modules/playwright` installation as a fallback.
They reuse an existing local QA browser cache when present. These checks require
Playwright and Chromium to have been installed separately; they do not download
dependencies or browsers. An installation outside the repository can be selected
explicitly:

```powershell
$env:PLAYWRIGHT_MODULE_PATH = "C:/tools/browser-qa/node_modules/playwright"
$env:PLAYWRIGHT_BROWSERS_PATH = "C:/tools/browser-qa/browsers"
node scripts/verify-dashboard-ui-preference.cjs
```

On other platforms, set the same environment variables with the shell's normal
syntax. `PLAYWRIGHT_BROWSERS_PATH` is preserved when already set; without an
explicit or local QA cache, Playwright uses its normal browser installation.
