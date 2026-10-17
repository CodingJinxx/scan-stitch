import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";

/**
 * Returns the versions map after releasing `targetVersion`.
 *
 * Obsidian docs (Reference/Versions): versions.json maps plugin versions to the
 * minAppVersion they need, and only has to change when minAppVersion changes.
 * A version is therefore recorded when the map is empty or when the most recent
 * entry has a different minAppVersion. This fixes the sample plugin's guard
 * (`!Object.values(versions).includes(minAppVersion)`), which wrongly skips a
 * change back to a minAppVersion that was recorded earlier.
 */
export function updateVersions(versions, targetVersion, minAppVersion) {
  const entries = Object.entries(versions);
  const last = entries.length ? entries[entries.length - 1][1] : undefined;
  if (last === minAppVersion) return versions;
  return { ...versions, [targetVersion]: minAppVersion };
}

function main() {
  const targetVersion = process.env.npm_package_version;
  if (!targetVersion) throw new Error("Run via `npm version <x.y.z>` (npm_package_version is not set).");

  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  const { minAppVersion } = manifest;
  manifest.version = targetVersion;
  // Two-space indent, the style of manifest.json, versions.json and package.json.
  writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

  const versions = JSON.parse(readFileSync("versions.json", "utf8"));
  const next = updateVersions(versions, targetVersion, minAppVersion);
  if (next !== versions) {
    writeFileSync("versions.json", JSON.stringify(next, null, 2) + "\n");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
