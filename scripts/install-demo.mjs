/**
 * Copies the built plugin (main.js, manifest.json, styles.css) into the demo vault.
 * Re-run after code changes (`npm run build && node scripts/install-demo.mjs`).
 *
 *   node scripts/install-demo.mjs [vaultDir]     default C:\Dev\scan-stitch-demo\vault
 *
 * It never touches data.json once it exists, so a session or settings in the demo vault
 * survive. Restart Obsidian (or reload the plugin) to pick up the new main.js.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vault = resolve(process.argv[2] ?? 'C:\\Dev\\scan-stitch-demo\\vault');
const dest = join(vault, '.obsidian', 'plugins', 'scan-stitch');
mkdirSync(dest, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  const from = join(repo, f);
  if (!existsSync(from)) {
    console.error(`${f} is missing: run "npm run build" first`);
    process.exit(1);
  }
  copyFileSync(from, join(dest, f));
  console.log(`copied ${f}`);
}
console.log(`Installed into ${dest}`);
