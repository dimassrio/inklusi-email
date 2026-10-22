import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const EDITIONS_DIR = join(ROOT, "editions");
const TEMPLATES_DIR = join(ROOT, "templates");
const DIST_DIR = join(ROOT, "dist");

type Scope = Record<string, unknown>;

interface Token {
    type: "text" | "var" | "open" | "inv" | "close" | "partial";
    name?: string;
    value?: string;
}

interface Node {
    type: Token["type"];
    name?: string;
    value?: string;
    children?: Node[];
}

const TOKEN_RE = /\{\{([#^/>]?)\s*([^}]*?)\s*\}\}/g;

function tokenize(template: string): Token[] {
    const tokens: Token[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN_RE.exec(template)) !== null) {
        if (match.index > last) tokens.push({ type: "text", value: template.slice(last, match.index) });
        const sigil = match[1] ?? "";
        const name = match[2] ?? "";
        const type: Token["type"] =
            sigil === "#" ? "open" : sigil === "^" ? "inv" : sigil === "/" ? "close" : sigil === ">" ? "partial" : "var";
        tokens.push({ type, name });
        last = TOKEN_RE.lastIndex;
    }
    if (last < template.length) tokens.push({ type: "text", value: template.slice(last) });
    return tokens;
}

function parse(tokens: Token[], pos = 0, stop?: string): { nodes: Node[]; next: number } {
    const nodes: Node[] = [];
    let i = pos;
    while (i < tokens.length) {
        const token = tokens[i]!;
        if (token.type === "close") {
            if (token.name === stop) return { nodes, next: i + 1 };
            throw new Error(`Unexpected {{/${token.name}}}`);
        }
        if (token.type === "open" || token.type === "inv") {
            const inner = parse(tokens, i + 1, token.name);
            nodes.push({ type: token.type, name: token.name, children: inner.nodes });
            i = inner.next;
        } else {
            nodes.push({ type: token.type, name: token.name, value: token.value });
            i += 1;
        }
    }
    if (stop) throw new Error(`Missing {{/${stop}}}`);
    return { nodes, next: i };
}

function lookup(stack: Scope[], path: string): unknown {
    const parts = path.split(".");
    for (let i = stack.length - 1; i >= 0; i -= 1) {
        let current: unknown = stack[i];
        let ok = true;
        for (const part of parts) {
            if (current !== null && typeof current === "object" && part in (current as Scope)) {
                current = (current as Scope)[part];
            } else {
                ok = false;
                break;
            }
        }
        if (ok) return current;
    }
    return undefined;
}

function renderNodes(nodes: Node[], stack: Scope[], partials: Record<string, Node[]>): string {
    let out = "";
    for (const node of nodes) {
        if (node.type === "text") {
            out += node.value ?? "";
        } else if (node.type === "var") {
            const value = lookup(stack, node.name ?? "");
            out += value === null || value === undefined ? "" : String(value);
        } else if (node.type === "partial") {
            const partial = partials[node.name ?? ""];
            if (!partial) throw new Error(`Missing partial: templates/partials/${node.name}.html`);
            out += renderNodes(partial, stack, partials);
        } else if (node.type === "open") {
            const value = lookup(stack, node.name ?? "");
            if (Array.isArray(value)) {
                value.forEach((item, index) => {
                    const ctx: Scope =
                        item !== null && typeof item === "object" ? { ...(item as Scope) } : { ".": item };
                    ctx.first = index === 0;
                    ctx.last = index === value.length - 1;
                    ctx.index = index + 1;
                    ctx.count = value.length;
                    out += renderNodes(node.children ?? [], [...stack, ctx], partials);
                });
            } else if (value !== null && value !== undefined && value !== false && value !== "") {
                const ctx = typeof value === "object" ? (value as Scope) : {};
                out += renderNodes(node.children ?? [], [...stack, ctx], partials);
            }
        } else if (node.type === "inv") {
            const value = lookup(stack, node.name ?? "");
            const empty =
                value === null ||
                value === undefined ||
                value === false ||
                value === "" ||
                (Array.isArray(value) && value.length === 0);
            if (empty) out += renderNodes(node.children ?? [], stack, partials);
        }
    }
    return out;
}

function loadPartials(): Record<string, Node[]> {
    const dir = join(TEMPLATES_DIR, "partials");
    const partials: Record<string, Node[]> = {};
    if (!existsSync(dir)) return partials;
    for (const file of readdirSync(dir)) {
        if (!file.endsWith(".html")) continue;
        const name = file.slice(0, -".html".length);
        partials[name] = parse(tokenize(readFileSync(join(dir, file), "utf8"))).nodes;
    }
    return partials;
}

function listEditions(): string[] {
    if (!existsSync(EDITIONS_DIR)) return [];
    return readdirSync(EDITIONS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
}

function defaultEdition(): string {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { edition?: string };
    if (pkg.edition) return pkg.edition;
    const editions = listEditions();
    if (editions.length === 1) return editions[0]!;
    throw new Error('No "edition" set in package.json and no single edition folder to infer it from.');
}

export function buildEdition(edition: string): { outDir: string; html: string } {
    const editionDir = join(EDITIONS_DIR, edition);
    const dataFile = join(editionDir, "edition.json");
    if (!existsSync(dataFile)) throw new Error(`Edition not found: editions/${edition}/edition.json`);

    const data = JSON.parse(readFileSync(dataFile, "utf8")) as Scope & {
        colors: Record<string, string>;
        stories: Scope[];
        products: Array<Scope & { band?: boolean }>;
        images: Record<string, string>;
    };
    const template = readFileSync(join(TEMPLATES_DIR, "base.html"), "utf8");
    const partials = loadPartials();

    data.imageBase = "images";

    for (const story of data.stories ?? []) {
        const theme = story.theme as string;
        story.bg = data.colors[theme] ?? theme;
    }

    const products = data.products ?? [];
    const productBand = products.filter((product) => product.band === true);
    const productPlain = products.filter((product) => product.band !== true);
    productPlain.forEach((product, index) => {
        product.topPad = index === 0 ? "24px" : "12px";
    });
    data.productBand = productBand;
    data.productPlain = productPlain;
    data.hasProductBand = productBand.length > 0;

    const html = renderNodes(parse(tokenize(template)).nodes, [data], partials);

    const outDir = join(DIST_DIR, edition);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "index.html"), html);

    const imagesDir = join(editionDir, "images");
    if (existsSync(imagesDir)) cpSync(imagesDir, join(outDir, "images"), { recursive: true });

    return { outDir, html };
}

if (import.meta.main) {
    const args = Bun.argv.slice(2);
    const editions = args.includes("--all") ? listEditions() : [args.find((arg) => !arg.startsWith("-")) ?? defaultEdition()];
    if (editions.length === 0) {
        console.error("No editions found in editions/.");
        process.exit(1);
    }
    for (const edition of editions) {
        const { outDir, html } = buildEdition(edition);
        const images = existsSync(join(outDir, "images")) ? readdirSync(join(outDir, "images")).length : 0;
        console.log(`✔ ${edition} -> dist/${edition}/index.html (${(html.length / 1024).toFixed(1)} KB, ${images} images)`);
    }
}
