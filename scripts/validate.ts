import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST_DIR = join(ROOT, "dist");
const EDITIONS_DIR = join(ROOT, "editions");

function defaultEdition(): string {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { edition?: string };
    if (!pkg.edition) throw new Error('No "edition" set in package.json.');
    return pkg.edition;
}

export interface ValidationResult {
    edition: string;
    failures: string[];
    warnings: string[];
}

interface Check {
    label: string;
    test: (html: string) => boolean;
}

const FORBIDDEN: Check[] = [
    { label: 'contains a <button> element (use a table-based button)', test: (html) => !/<button[\s>]/i.test(html) },
    { label: "uses display:flex (not supported in Outlook)", test: (html) => !/display\s*:\s*flex/i.test(html) },
    { label: "uses display:grid (not supported in Outlook)", test: (html) => !/display\s*:\s*grid/i.test(html) },
    { label: "uses a <div> (layout must use tables)", test: (html) => !/<div[\s>]/i.test(html) },
    { label: "contains a <script> tag", test: (html) => !/<script[\s>]/i.test(html) },
    { label: "links an external stylesheet (<link rel=stylesheet>)", test: (html) => !/<link[^>]+stylesheet/i.test(html) },
];

const REQUIRED: Check[] = [
    { label: "missing Mailchimp merge tag *|MC:SUBJECT|*", test: (html) => html.includes("*|MC:SUBJECT|*") },
    { label: "missing Mailchimp merge tag *|ARCHIVE|*", test: (html) => html.includes("*|ARCHIVE|*") },
    { label: "missing <o:OfficeDocumentSettings> block", test: (html) => html.includes("o:OfficeDocumentSettings") },
    { label: "missing <o:PixelsPerInch>96</o:PixelsPerInch>", test: (html) => html.includes("<o:PixelsPerInch>96</o:PixelsPerInch>") },
    { label: "missing mso-table-lspace:0pt on tables", test: (html) => html.includes("mso-table-lspace:0pt") },
    { label: "missing role=\"presentation\" layout tables", test: (html) => html.includes('role="presentation"') },
    { label: "missing an Outlook conditional comment (<!--[if mso]>)", test: (html) => /<!--\[if mso\]>/.test(html) },
    { label: "missing mso-line-height-rule:exactly on text", test: (html) => html.includes("mso-line-height-rule:exactly") },
    { label: "missing -ms-interpolation-mode:bicubic on images", test: (html) => html.includes("-ms-interpolation-mode:bicubic") },
    { label: "missing align-center wrapper / 660px container", test: (html) => html.includes("max-width:660px") },
];

function checkImages(edition: string, html: string, failures: string[]): void {
    const dir = join(DIST_DIR, edition);
    const srcs = [...html.matchAll(/src="([^"]+)"/g)].map((match) => match[1]!);
    for (const src of srcs) {
        if (/^https?:\/\//i.test(src) || src.startsWith("*|") || src.startsWith("mailto:")) continue;
        if (!existsSync(join(dir, src))) failures.push(`missing image asset referenced by src="${src}"`);
    }

    const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
    imgTags.forEach((tag, index) => {
        if (!/\bwidth=/.test(tag)) failures.push(`<img> #${index + 1} has no width attribute`);
        if (!/max-width/.test(tag)) failures.push(`<img> #${index + 1} has no inline max-width`);
    });
}

function checkColorPairs(html: string, failures: string[]): void {
    const bgcolors = new Set([...html.matchAll(/bgcolor="(#[0-9a-fA-F]{6})"/g)].map((match) => match[1]!.toLowerCase()));
    for (const color of bgcolors) {
        if (!html.toLowerCase().includes(`background-color:${color}`)) {
            failures.push(`bgcolor="${color}" has no matching inline background-color (Outlook needs both)`);
        }
    }
}

export function validateEdition(edition: string): ValidationResult {
    const failures: string[] = [];
    const warnings: string[] = [];
    const file = join(DIST_DIR, edition, "index.html");

    if (!existsSync(file)) {
        return { edition, failures: [`no build found at dist/${edition}/index.html (run the build first)`], warnings };
    }

    const html = readFileSync(file, "utf8");

    if (!existsSync(join(EDITIONS_DIR, edition, "edition.json"))) {
        warnings.push(`editions/${edition}/edition.json not found`);
    }

    for (const check of [...FORBIDDEN, ...REQUIRED]) {
        if (!check.test(html)) failures.push(check.label);
    }

    checkImages(edition, html, failures);
    checkColorPairs(html, failures);

    return { edition, failures, warnings };
}

if (import.meta.main) {
    const args = Bun.argv.slice(2);
    const editions = args.includes("--all")
        ? [...new Bun.Glob("*").scanSync({ cwd: EDITIONS_DIR, onlyFiles: false })]
        : [args.find((arg) => !arg.startsWith("-")) ?? defaultEdition()];

    let failed = false;
    for (const edition of editions) {
        const { failures, warnings } = validateEdition(edition);
        for (const warning of warnings) console.warn(`  ⚠ ${warning}`);
        if (failures.length === 0) {
            console.log(`✔ ${edition}: passed Outlook-safety and asset checks`);
            continue;
        }
        failed = true;
        console.error(`✘ ${edition}: ${failures.length} problem(s)`);
        for (const failure of failures) console.error(`    - ${failure}`);
    }
    if (failed) process.exit(1);
}
