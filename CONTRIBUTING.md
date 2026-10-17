# Contributing to Scan Stitch

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for a feature

Open an issue with the matching template. For bugs, the Obsidian version, your OS, the plugin version and the scanner's file type (PDF, JPEG, PNG) save a lot of back and forth. Please never attach real scans with personal data; `scripts/make-demo-scans.mjs` makes synthetic pages that reproduce most problems.

## Ground rules for changes

These come from the [design spec](docs/superpowers/specs/2026-10-17-scan-stitch-design.md) and are not negotiable:

- Never modify, move or delete anything in the scanner folder. It is read only.
- Never silently overwrite a file in the vault.
- No network access, no telemetry.
- Follow Obsidian's [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines): sentence-case UI text, no default hotkeys, no `innerHTML`, Obsidian CSS variables so both themes work, clean unload.

For anything larger than a fix, open an issue first so we can agree on the approach.

## Setting up

Node.js 22.12 or newer.

```bash
npm ci
npm run dev        # rebuilds main.js on change
```

Try it in a throwaway vault with synthetic pages:

```bash
npm run build
node scripts/install-demo.mjs <vaultDir>
node scripts/make-demo-scans.mjs <scannerDir>
node scripts/make-demo-scans.mjs --drip <stagedDir> <scannerDir> 4
```

## Before opening a pull request

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

All four must pass (CI runs the same). Put pure logic in testable modules without Obsidian imports (see `src/core/` and the `*Logic.ts` files in `src/ui/`) and add vitest tests next to the existing ones in `tests/`. For UI changes, walk through the relevant items of [docs/qa-checklist.md](docs/qa-checklist.md) and attach light and dark screenshots.

Keep pull requests focused, one change per PR, and describe what you tested.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
