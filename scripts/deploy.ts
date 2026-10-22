import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildEdition } from "./build";
import { validateEdition } from "./validate";

const ROOT = resolve(import.meta.dir, "..");
const DIST_DIR = join(ROOT, "dist");
const BESTZIP = join(ROOT, "node_modules", ".bin", "bestzip");

function defaultEdition(): string {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { edition?: string };
    if (!pkg.edition) throw new Error('No "edition" set in package.json.');
    return pkg.edition;
}

const args = Bun.argv.slice(2);
const edition = args.find((arg) => !arg.startsWith("-")) ?? defaultEdition();

console.log(`Building ${edition}...`);
const { outDir, html } = buildEdition(edition);
console.log(`  ✔ dist/${edition}/index.html (${(html.length / 1024).toFixed(1)} KB)`);

const result = validateEdition(edition);
for (const warning of result.warnings) console.warn(`  ⚠ ${warning}`);
if (result.failures.length > 0) {
    console.error(`  ✘ validation failed:`);
    for (const failure of result.failures) console.error(`    - ${failure}`);
    process.exit(1);
}
console.log(`  ✔ validation passed`);

if (!existsSync(BESTZIP)) {
    console.error(`bestzip not found at node_modules/.bin/bestzip. Run: bun install`);
    process.exit(1);
}

const zipPath = join(DIST_DIR, `${edition}.zip`);
rmSync(zipPath, { force: true });
const sources = existsSync(join(outDir, "images")) ? ["index.html", "images"] : ["index.html"];
const zip = spawnSync(BESTZIP, [`../${edition}.zip`, ...sources], { cwd: outDir, stdio: "inherit" });
if (zip.status !== 0) {
    console.error("bestzip failed");
    process.exit(1);
}
console.log(`  ✔ dist/${edition}.zip`);
