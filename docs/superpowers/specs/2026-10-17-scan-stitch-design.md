# Scan Stitch: design

Status: draft for approval, 2026-10-17. Plugin name "Scan Stitch", id `scan-stitch`. Target: the Obsidian community plugins store. Everything below ships in one pass; there are no staged versions.

## 1. Intent and why

Many flatbed and sheet-fed scanners (the author's is a Canon) write **one file per page** into a folder. Turning a stack of those into one correctly oriented PDF in a vault is tedious by hand. Scan Stitch turns that into a short session: start a scan session, scan pages while Obsidian is visible, end the session, check rotation, save one merged PDF into the vault.

This is a rewrite of the scanning feature of the author's earlier plugin `jinxx-tools` (github.com/CodingJinxx/jinxx-tools: `ScanService.ts`, `LiveScanMonitorModal.ts`). That plugin tied scanning to a "course" concept and its review UI took too many clicks for rotation. Scan Stitch is a standalone, scanner-agnostic plugin with no course concept and a keyboard-first review screen.

Success for the author: scanning a stack, fixing the few wrong-way pages, and saving takes a handful of key presses, and nothing is lost if Obsidian closes mid-session.

## 2. Goals, non-goals, anti-goals

**Goals**
- Works with any scanner that writes one file per page into a folder (configurable root, subfolders, file pattern).
- Live scanning feedback in a side pane: page count, thumbnail of the last page, a button to discard the last page.
- Fast review: one large page plus a filmstrip, keyboard driven. Rotate, reorder, delete, range-select.
- Save to a chosen vault folder with reusable named filename templates; optionally append to an existing PDF.
- Recent destinations remembered.
- Session survives an Obsidian restart.
- Passes the Obsidian community plugin review guidelines.

**Non-goals**
- Auto-detecting page orientation (decided: not worth the effort; no OCR).
- Controlling the scanner or any driver. The plugin only reads files the scanner already wrote.
- Mobile support (needs Node `fs` to watch a folder outside the vault).
- TIFF input (cannot be embedded by pdf-lib or decoded by the app's web view).
- Any network access.

**Anti-goals (would make it a failure even if it technically works)**
- Modifying, moving or deleting anything in the scanner folder, ever. Read only.
- Silently overwriting an existing file in the vault.
- Losing scanned pages (crash, restart, accidental Esc).
- A review flow that needs many clicks per page or menus to rotate.

## 3. Constraints

- Obsidian plugin in TypeScript, `isDesktopOnly: true`. Uses Node `fs` for the watched folder and Obsidian APIs for everything inside the vault.
- No network calls, no telemetry, no `innerHTML` with dynamic content, clean unload (all watchers, timers and events released).
- Store rules: id does not contain "obsidian", name does not end in "plugin", MIT licence, README, sentence-case UI text, command names without the plugin name prefix, no default hotkeys on commands, UI built with Obsidian CSS variables so it works in light and dark themes.
- The author's scanner layout, as observed: root `C:\Dev\Scans` contains one folder per day (`2026_06_29`, `2026_10_13`) holding `IMG_0001.pdf`, `IMG_0002.pdf` and so on. Numbering **restarts at `IMG_0001` in each day folder**. So file names are not unique and cannot be used for page identity or ordering.

## 4. How it works (decided with the author)

### 4.1 Settings
- **Watch root**: absolute path, set once. Text field plus a browse button.
- **Include subfolders**: default on. A new subfolder created mid-session (scanning across midnight) must be picked up.
- **File patterns**: default `*.pdf`. Image types `*.jpg`, `*.jpeg`, `*.png` can be enabled (embedded as page images).
- **Stability check**: delay and retries before a new file is counted, so half-written files are skipped (defaults carried over from jinxx-tools: 1000 ms, 3 retries).
- **Templates**: named filename templates, a default template, add/edit/delete (see 4.4).
- **Recent locations**: clear history.

### 4.2 Starting a session
A command and a ribbon icon open a small start dialog:
- **Destination folder**: fuzzy-search picker over vault folders, plus a **Recent** list (last 5 used, newest first, newest preselected so Enter is the common path).
- **Template** dropdown (default template preselected) with a **live preview** of the resulting file name.
- **Append to existing PDF** toggle; when on, a picker to choose a PDF in the vault instead of folder + template.

On start the plugin records which files already exist under the watch root. Only files that appear afterwards count.

### 4.3 Scanning (side pane)
A side pane opens (right sidebar):
- A "Scanning" indicator, a large page counter, a thumbnail of the **last** page that arrived.
- **Discard last**: removes the newest page from the session, counter goes down, thumbnail shows the previous page. The file on disk is **not touched**. A discarded path is remembered so it is not picked up again; the rescan arrives as a new file and takes the end position. Can be pressed repeatedly.
- **End session** button (also a command) opens the review screen.
- A status bar item shows the live count while a session is running (builder's call, not discussed).

Page identity is the full file path. **Order is by the time the plugin saw each file finish writing**, with file name as a tie-breaker. Never by name across folders.

### 4.4 Templates
- Placeholders use braces: `{date}`, `{time}`, `{year}`, `{month}`, `{day}`, `{pages}`, `{counter}`, `{folder}` (name of the destination folder). Optional format after a colon for date/time, using moment.js format tokens, for example `{date:YYYY-MM-DD}`.
- Named and reusable. A template can optionally store a destination folder; picking it then preselects that folder.
- Defaults (builder's call): `{date}` formats as `YYYY-MM-DD`, `{time}` as `HH-mm` (filename safe); `{counter}` is the next unused integer for that resulting name in the destination; `{pages}` resolves at save time (preview shows it unresolved).
- Resulting names are sanitised for illegal filename characters. If the name already exists, append ` 2`, ` 3`, ... Never overwrite.
- Unknown placeholders are left as literal text and flagged in the settings editor.

### 4.5 Review screen
Opens as a full view (tab) after End session. Layout chosen from three mockups ("B: focus mode"):
- Top bar: filename (editable), page counter "Page 3 / 12", **Save** and **Save and open** buttons.
- Centre: one large rendering of the current page.
- Bottom: filmstrip of thumbnails, current page highlighted, scrolls horizontally. Rotated pages show a small marker.
- Keys: **R** rotate 90° clockwise, **Shift+R** counter-clockwise, **←/→** previous/next page, **Del** remove page, **Enter** save, **Esc** cancel (confirm if changes were made). Click a thumbnail to jump. **Drag** thumbnails to reorder. **Shift+click** selects a range; **R** then rotates the whole range. **Ctrl+Z / Ctrl+Y** undo/redo for rotate, delete, reorder.
- Opens on page 1. No auto-rotation, no "flagged page" navigation.
- Rendering of PDF pages uses the pdf.js Obsidian already ships (`loadPdfJs` from the `obsidian` module). Image pages render as images. Thumbnails render lazily.

### 4.6 Saving
- **Save** writes the merged PDF and ends the session. **Save and open** does the same and then opens the new PDF in a leaf.
- Merge with pdf-lib (the only bundled runtime dependency): copy pages in review order, apply each page's rotation on top of its existing `/Rotate`, embed image pages as full pages sized to the image.
- The file goes into the destination folder (created if missing) via the vault API.
- In append mode the new pages are added after the existing PDF's pages. **Decided by the author:** the review screen shows only the new pages; the existing PDF's pages stay untouched and cannot be rotated, deleted or reordered there. In append mode the filename field is hidden (the target file is fixed), the page counter and undo cover only the new pages, and the header shows "Appending to <file> (N existing pages)". The existing file must never be lost on failure: see "Append verify/replace" in 5b.
- A notice reports file name and page count. The scanner folder is not modified.

### 4.7 Resilience
- Session state (watch root, destination, template, ordered page list with rotations, discarded paths, start time) is persisted to the plugin data as it changes.
- On startup, if a session was open, offer to resume it (to the scanning pane or to review) or to drop it.
- Esc in review does not drop the session; it returns to the scanning pane (or offers "keep for later" / "discard session").

## 5. Left to the builder
- Watching mechanism: recursive `fs.watch` where reliable, with a polling fallback. Pick based on testing on Windows, macOS, Linux.
- Exact start-dialog and review-screen visual design and CSS (use the `frontend-design` skill; must feel native to Obsidian, both themes, keyboard accessible, readable at small pane widths).
- Whether the backup-before-append setting from jinxx-tools returns (author did not decide; the replace-after-verify rule above is the requirement).
- Memory strategy for large stacks (render thumbnails lazily, merge sequentially).
- Project tooling (marked as my calls): official sample-plugin esbuild setup, `eslint-plugin-obsidianmd`, vitest for pure logic (template engine, ordering, session store, merge), GitHub Actions release workflow.
- Repo layout, README with screenshots/GIFs, MIT licence, `versions.json`/`manifest.json`.

## 5a. Repository presentation (requested by the author)
The repo should look polished, as part of the same one-pass delivery:
- **Logo**: designed with Claude's design tools (a Design artifact), exported as SVG and PNG. Used in the README header, the GitHub Pages site and the social preview image.
- **Screenshots** of the real plugin: start dialog, scanning side pane, review screen (focus mode), settings. Light and dark theme.
- **Demo GIF** of a full session: start, pages arriving and the counter rising, discard last, review with rotate, Save and open. Recorded against a demo vault and a fake scanner folder filled with synthetic sample pages. The author's real scans are never used.
- **README**: logo, one-line pitch, GIF at the top, feature list, install (community store and manual), usage, settings, keyboard shortcuts table, FAQ, licence.
- **GitHub Pages** site: a single landing page (logo, GIF, features, install link, screenshots), deployed from the repo by a GitHub Actions workflow.
- Standard repo hygiene: topics, description, issue templates, `CONTRIBUTING`, release notes template.
- Creating the GitHub repo, pushing, enabling Pages and publishing a release are outward-facing; each needs the author's explicit go-ahead at that moment.

## 5b. Calls made after the builder check (mine, not discussed with the author)
- **Append verify/replace**: build the merged bytes in memory, reopen them with pdf-lib and require page count = old + new. Before replacing, copy the original into the plugin's own folder; replace with a single `modifyBinary`; delete the copy once the write succeeds. On any failure the original stays and the copy is kept.
- **Image pages**: apply EXIF orientation first, then the manual rotation. Page size = pixels at the image's DPI when present, else 150 DPI. PNG alpha is flattened onto white.
- **Multi-page input PDFs**: the file is the unit for counting and "Discard last"; all of its pages go into the review as separate reviewable pages, rotation stored per page.
- **Baseline**: no full scan of the watch root. A file counts if its creation/modification time is at or after the session start and its path is not in the discarded list. On resume after a restart, files that arrived while Obsidian was closed and meet that rule are picked up.
- **Resume**: page files that no longer exist are skipped with a notice. Starting a session while one is open asks to resume or replace it. Destination and template are saved when the session starts.
- **Recent locations**: folders only, recorded on a successful save (abandoned sessions do not pollute the list).
- **Platforms**: Windows is the primary tested platform; macOS and Linux are best effort through the polling fallback and careful path handling.

## 6. My calls the author has not seen
Status bar counter; 5 recent locations; `{counter}` and date/time default formats; image input limited to jpg/png; filename editable on the review screen; Esc returns to scanning instead of dropping the session; page order tie-breaker; polling fallback; tooling choices above.
