# Store submission checklist (Obsidian Community directory)

Checked 2026-10-17 against the official sources listed at the bottom. Status per line: PASS, FAIL, N-A, UNVERIFIED.

## 0. Important changes found while verifying

- **Submission is no longer a pull request to `obsidianmd/obsidian-releases`.** The current "Submit your plugin" page says to sign in at community.obsidian.md, link GitHub, and add the plugin there. `obsidianmd/obsidian-releases` now only mirrors the directory (its recent commits are bot "Mirror community plugins and themes"), its README says it does not accept issues, and `.github/PULL_REQUEST_TEMPLATE/plugin.md` no longer exists (404). A hand-written `community-plugins.json` entry and PR therefore are not part of the documented flow. A draft entry is kept in section 7 for reference only. UNVERIFIED whether the PR route is still processed; follow the official page.
- **The release tag must equal `manifest.json` `version` exactly, i.e. `1.0.0`, not `v1.0.0`.** Obsidian looks for "GitHub releases tagged identically to the version inside manifest.json" (obsidian-releases README, "How community plugins are pulled"; Submit your plugin, Step 2). The release workflow therefore creates the release under the bare version even if a `v1.0.0` tag is pushed. Pushing the bare tag `1.0.0` is preferred.
- **1.0.0 was reviewed by the directory's review bot; 1.0.1 answers every point.** See section 10 for the feedback and how each item was handled.
- `versions.json` only needs an entry when `minAppVersion` changes (Reference/Versions: "You don't need to list every plugin release"), so `version-bump.mjs` records a version only then.
- The official sample workflow also creates a build attestation (`actions/attest`) and a draft release. Ours creates a published release with generated notes. Since 1.0.1 it also attests the release assets (the review bot recommended it for 1.0.0); see section 3.

## 1. Required files in repo root

| Status | Rule | Evidence |
|---|---|---|
| PASS | `README.md` describes purpose and how to use the plugin (excerpt is shown on the listing) | `README.md:8` one-line pitch, `:16` Why, `:20` Features, `:32` How it works, `:57` Install, `:71` Usage (commands, keyboard shortcuts, templates, append mode), `:147` Settings, `:179` FAQ |
| PASS | `LICENSE` present and license clearly indicated | `LICENSE` (MIT, Jay Leimer); `package.json` `"license": "MIT"` |
| PASS | `manifest.json` present | `manifest.json` |
| PASS | `versions.json` present (older-app fallback) | `versions.json` = `{"1.0.0": "1.5.0"}` (1.0.1 keeps `minAppVersion` 1.5.0, so no new entry) |

## 2. Manifest (Reference/Manifest, Submission requirements for plugins)

| Status | Rule | Evidence |
|---|---|---|
| PASS | Required fields `id`, `name`, `version`, `minAppVersion`, `description`, `author`, `isDesktopOnly` | `manifest.json` lines 2 to 9 |
| PASS | `version` is `x.y.z` semver | `1.0.2` |
| PASS | `id`: lowercase letters and hyphens, no "obsidian", does not end in "plugin" | `scan-stitch` |
| UNVERIFIED | `id` unique across published plugins | not checked against the live directory; before submitting run `gh api -H "Accept: application/vnd.github.raw" repos/obsidianmd/obsidian-releases/contents/community-plugins.json` and search for `"id": "scan-stitch"` |
| PASS | `name`: short, English/Basic Latin, only hyphen, plus, parentheses as punctuation, no emoji, no "Obsidian", no "Plugin", not a core feature name | "Scan Stitch" |
| UNVERIFIED | `name` unique in the directory | same check as for the id |
| PASS | `description` at most 250 characters | 85 characters |
| PASS | `description` ends with a period | "...fast rotation review." |
| PASS | `description` has no emoji or special characters, starts with an action statement, does not start with "This is a plugin" | "Combine one-file-per-page scanner output into a single PDF with fast rotation review." |
| PASS | Capitalisation of "PDF" is correct | same line |
| PASS (partly UNVERIFIED) | `minAppVersion` appropriate | `1.5.0`. UNVERIFIED that every API used exists in 1.5.0 (the plan flagged `loadPdfJs` and `fs.watch` recursive behaviour); `docs/qa-checklist.md` covers a manual run. |
| N-A | `fundingUrl` only if donations are accepted, otherwise removed | field absent |
| PASS | `authorUrl` optional | `https://github.com/CodingJinxx` |
| PASS | `isDesktopOnly: true` justified | Node `fs`/`path` and Electron are used: `src/main.ts:1`, `src/scan/folderWatcher.ts:1-2`, `src/scan/sessionController.ts:1-2`, `src/ui/SettingsTab.ts:1` and `:44` (`require('electron')`). Submission requirements: Node/Electron use requires `isDesktopOnly: true`. |
| PASS | Command ids do not contain the plugin id | `start-session`, `end-session`, `discard-last-page`, `resume-session` (`src/main.ts:88-110`) |
| PASS | Sample code removed | `grep -rniE "MyPlugin|SampleSettingTab|sample" src` finds only a comment about image resampling (`src/pdf/merge.ts:155`) |

## 3. Release (Submit your plugin, Step 2)

| Status | Rule | Evidence |
|---|---|---|
| PASS (not yet run) | Release attaches `main.js`, `manifest.json`, `styles.css` as binary assets | `.github/workflows/release.yml`, step "Create GitHub release": `gh release create "$VERSION" main.js manifest.json styles.css` |
| PASS (not yet run) | Release tag exactly equals manifest `version` | workflow strips a leading `v` and creates the release under `$VERSION`; the check step fails the job unless the tag minus `v` equals both `manifest.json` and `package.json` versions |
| PASS | `manifest.json`, `package.json`, `versions.json` agree | `manifest.json` and `package.json` `1.0.2`; `versions.json` maps `1.0.0` to `1.5.0`, which covers 1.0.1 and 1.0.2 (section 8) |
| PASS | Build output exists | `main.js` (585134 bytes), `manifest.json`, `styles.css` after `npm run build`; `main.js` is gitignored and built in CI |
| FAIL (human step) | A GitHub release must exist before submission | none yet; see section 9 |
| UNVERIFIED | Repo setting "Workflow permissions: read and write" (docs recommend it; the workflow also declares `permissions: contents: write`) | needs a look at Settings > Actions > General on GitHub |
| PASS (not yet run) | Release assets carry GitHub artifact attestations (review bot recommendation for 1.0.0) | `.github/workflows/release.yml`, step "Attest build provenance": `actions/attest-build-provenance@v4` (a wrapper over `actions/attest`) with `subject-path` `main.js`, `manifest.json`, `styles.css`, after the build and before the release; job permissions `contents: write`, `id-token: write`, `attestations: write`. `artifact-metadata: write` is not granted: it is only needed for storage records, which apply to registry pushes. Verify after the first run: `gh attestation verify main.js --repo CodingJinxx/scan-stitch` (also documented in `README.md`, Install). |

## 4. Developer policies (Community directory/Developer policies)

| Status | Rule | Evidence |
|---|---|---|
| PASS | No obfuscated code | esbuild production bundle is minified only (`esbuild.config.mjs:24`), not obfuscated; source is public |
| PASS | No ads, no client-side telemetry | `grep -rniE "telemetry|analytics" src` finds nothing |
| PASS | No network use | `grep -rnE "fetch\(|requestUrl|XMLHttpRequest|WebSocket|https?://" src` finds none. Stated in `README.md:193` ("No network access, no telemetry, no account"). |
| PASS | Does not install or update itself or its dependencies | no such code |
| PASS (disclosure) | Access to files outside the vault must be clearly explained in the README | the plugin watches a scanner folder outside the vault (`src/scan/folderWatcher.ts`); `README.md:183` "Privacy and file access": reads PDF/JPEG/PNG from the configured scanner folder outside the vault and why (`:188`), Node `fs` used only for that folder and nothing written outside the vault (`:189`), never modifies, moves or deletes anything there (`:190`), writes only into the vault (`:191`), lists vault folder and PDF paths but not note contents (`:192`), desktop only, session state in `data.json` |
| N-A | Payment, account, static ads, server telemetry, closed source | none apply |
| PASS (partly UNVERIFIED) | Licence compliance and attribution of bundled code | pdf-lib is MIT. Transitive licences not audited: UNVERIFIED. |
| PASS | Not a fork | original code |
| PASS | Trademark: no confusing use of "Obsidian" | name and description do not contain it |

## 5. Plugin guidelines (Plugins/Releasing/Plugin guidelines)

| Status | Rule | Evidence |
|---|---|---|
| PASS | No global `app` / `window.app`; use `this.app` | `grep -rnE "window\.app"` finds none; `src/ui/ReviewView.ts:811` is `const { app } = this`, so the later `app.` uses (847, 849) are the instance's |
| PASS | Console output limited | `grep -rn "console\." src` finds none |
| PASS | No `innerHTML`, `outerHTML`, `insertAdjacentHTML` | `grep -rnE "innerHTML|outerHTML|insertAdjacentHTML" src` finds none |
| PASS | Cleanup on unload | `src/main.ts:116-122` closes the modal, shuts the controller/watcher down, disposes the renderer; events use `registerEvent`/`this.register` (`src/main.ts:81`, `src/ui/ReviewView.ts:127`) |
| PASS | Do not detach leaves in `onunload` | not done |
| PASS | No default hotkeys | `grep -rn "hotkeys" src` finds none |
| PASS | Right callback type per command | `callback` for start/resume, `checkCallback` for conditional end/discard (`src/main.ts:88-110`) |
| PASS | Settings headings via `setHeading()`, sentence case, no "settings" in heading, no plugin-name heading | headings listed once in `src/ui/SettingsTab.ts:101-105`; drawn with `setHeading()` on < 1.13 (`src/ui/settingSections.ts:86`) and as group headings on 1.13+ |
| PASS | No `workspace.activeLeaf`; no `Vault.modify` on the active note | none found; `vault.modifyBinary` at `src/ui/ReviewView.ts:906` writes a generated PDF, not a note |
| PASS | `const`/`let` instead of `var` | `grep -rnE "\bvar " src` finds none |
| PASS (note) | Prefer `async`/`await` over `.then()` | seven short `.then()` uses, mostly promise chaining and fire-and-forget renders (`src/main.ts:190`, `src/scan/sessionController.ts:244` and `:361`, `src/pdf/pageRenderer.ts:119`, `src/ui/ReviewView.ts:472` and `:663`, `src/ui/ScanPaneView.ts:138`), a "prefer", not a rule |
| PASS (note) | Avoid inline styles | the only inline styles set computed per-image size and rotation (`src/ui/ScanPaneView.ts:178-180`), which static CSS cannot express; everything else is in `styles.css` |
| PASS | Mobile guidance (Node APIs, lookbehind) | desktop only; no regex lookbehind (`grep -rnE "\(\?<[=!]" src` is empty) |
| N-A / UNVERIFIED | Editor extensions, `registerView` factory references, frontmatter, `normalizePath` | no editor extension; vault paths via the Vault API; not exhaustively audited for `normalizePath` |

## 6. Lint: `eslint-plugin-obsidianmd`

`npm run lint` exits 0: 0 errors, 0 warnings (1.0.1).

The 10 warnings of 1.0.0 are gone without raising `minAppVersion` (details in section 10): the settings tab implements `getSettingDefinitions()` with `display()` kept as the fallback for 1.5.0 to 1.12, no code calls the deprecated `display()` any more, and destructive buttons use `setDestructive()` when the running app has it and the `mod-warning` class otherwise.

The review bot also reported `no-unsafe-*` findings on `moment(...)` calls that our local lint did not show (with the `moment` package's types installed, `moment` is typed). They were reproduced locally by hiding those types (15 findings) and are gone in 1.0.1 (0 findings with the types hidden).

## 7. Draft submission data

Submit through the directory form (community.obsidian.md > Plugins > New plugin):

- GitHub repository URL: `https://github.com/CodingJinxx/scan-stitch`
- Owner: yourself
- Agree to the Developer policies and confirm continued support

Reference only: the legacy `community-plugins.json` entry shape (as in the mirrored file today). Do not open a PR with it unless the official page returns to that route.

```json
{
  "id": "scan-stitch",
  "name": "Scan Stitch",
  "author": "Jay Leimer",
  "description": "Combine one-file-per-page scanner output into a single PDF with fast rotation review.",
  "repo": "CodingJinxx/scan-stitch"
}
```

Legacy PR title and body, UNVERIFIED because the PR template no longer exists: title `Add plugin: Scan Stitch`; body with a one-line description, the repo link, the release link, and a statement that the Developer policies were read and followed.

## 8. Dry run (2026-10-17)

- `npm run lint`: 0 errors, 0 warnings (section 6)
- `npm run typecheck`: clean
- `npm test`: 20 files, 290 tests passed (includes `tests/versionBump.test.ts`, `tests/ui/dateFormat.test.ts`, `tests/ui/settingSections.test.ts`)
- `npm run build`: ok; `main.js`, `manifest.json`, `styles.css` present
- Versions: `manifest.json` 1.0.2, `package.json` 1.0.2, `package-lock.json` 1.0.2, `versions.json` `{"1.0.0": "1.5.0"}` (bumped with `npm version 1.0.2 --no-git-tag-version`; no tag created)
- `.github/workflows/release.yml` parses as valid YAML (`yaml` package from a scratch install outside the repo), including the new attestation step. Not executed on GitHub.

## 9. Human-only steps remaining

1. ~~Write the README~~ done (purpose, usage, settings, disclosures; see section 1 and 4).
2. Push and merge; confirm the repo's Actions setting allows workflow write permissions.
   For the landing page, set Settings → Pages → Build and deployment → Source to "GitHub Actions" before `.github/workflows/pages.yml` can deploy (then run it once via workflow_dispatch or push a change under `docs/site/`).
3. Tag and push `1.0.1` (preferred) or `v1.0.1`; check the Release run, that the release has tag `1.0.1` and exactly `main.js`, `manifest.json`, `styles.css`, and that `gh attestation verify main.js --repo CodingJinxx/scan-stitch` succeeds for the downloaded assets.
4. Check `id` and `name` are unique in the directory.
5. Sign in at community.obsidian.md, link GitHub, add the plugin (section 7), agree to the policies.
6. Answer automated review feedback: fix in the repo and publish a new release with an incremented version.
7. After listing: announce in the forum (Share & showcase) and Discord `#updates` (needs the `developer` role).

## 10. Review bot feedback on 1.0.0 and how 1.0.1 handles it

Passed on 1.0.0: network patterns, dependencies, obfuscation, reproducible build.

| Feedback (1.0.0) | Kind | 1.0.1 |
|---|---|---|
| Release assets `main.js` and `styles.css` have no GitHub artifact attestations | recommendation | `.github/workflows/release.yml` attests `main.js`, `manifest.json` and `styles.css` with `actions/attest-build-provenance@v4` after the build and before the release (section 3). How to verify: `README.md`, Install. |
| Direct Node `fs` access | behaviour note | Expected for this plugin (desktop only). `README.md`, "Privacy and file access", now says plainly that `fs` is used only to list, watch, check and read the configured scanner folder and that nothing is written outside the vault. |
| Vault enumeration (`vault.getFiles`, ...) | behaviour note | Used only to fill the destination folder picker (folder paths from `getAllLoadedFiles`) and the append target picker (PDF paths from `getFiles`), `src/ui/FolderSuggest.ts`. Disclosed in the same README section: paths, not note contents. |
| `no-unsafe-return` / `no-unsafe-call` / `no-unsafe-member-access` at `src/ui/ReviewView.ts:379`, `:935`, `src/ui/SettingsTab.ts:332`, `src/ui/StartDialog.ts:220` | lint | All were `moment(...)` from `obsidian`, typed `any` when the `moment` package's types do not resolve. Now `formatDate`/`nowStamp` in `src/ui/dateFormat.ts`, which cast `moment` to a small local type. |
| `PluginSettingTab` does not implement `getSettingDefinitions()` (`src/ui/SettingsTab.ts:51`) | lint | Implemented. The tab is described once (`src/ui/settingSections.ts`) and either rendered by Obsidian 1.13+ from definitions (with names, descriptions and search aliases) or drawn by `display()` on 1.5.0 to 1.12. |
| `display` deprecated since 1.13 (re-render calls in `src/ui/SettingsTab.ts`) | lint | Re-renders call `rerender()`: `update()` on 1.13+ (feature-detected), otherwise the imperative render. `display()` remains only as the override that older versions call. |
| `setWarning` deprecated, use `setDestructive` (`src/ui/LifecycleModals.ts:19`, `:115`) | lint | `markDestructive()` calls `setDestructive()` when it exists (1.13+) and otherwise adds `mod-warning`, which is what `setWarning()` did. |
| CSS: `scrollbar-width` only partially supported by Obsidian 1.4.5 (`styles.css:435`) | CSS lint | Removed; the filmstrip uses Obsidian's default scrollbar. |
| CSS: avoid `!important` (`styles.css:4`, `.scan-stitch-hidden`) | CSS lint | Replaced by a repeated-class selector (specificity 0,3,0) that outranks every `display` rule on the hidden elements; checked with computed styles. |

UNVERIFIED until a real Obsidian run: the 1.13+ declarative settings tab (layout, search hits, re-render after template changes) and the destructive button style on both old and new app versions. The 1.5.0 path is unchanged in output.

## Sources

- https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin
- https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- obsidianmd/obsidian-developer-docs: `en/Community directory/Developer policies.md`, `Submission requirements for plugins.md`, `Set up and claim.md`, `en/Reference/Manifest.md`, `en/Reference/Versions.md`, `en/Plugins/Releasing/Release your plugin with GitHub Actions.md`
- https://github.com/obsidianmd/obsidian-releases (README, `community-plugins.json`, `plugin-review.md`)
