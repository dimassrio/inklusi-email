# AGENTS.md

## Project

**Kabar Inklusi** — a static HTML **email newsletter** for the INKLUSI program
(Kemitraan Australia–Indonesia Menuju Masyarakat yang Inklusif). The output is a
single self-contained HTML file plus images, uploaded to / sent via **Mailchimp**.

There is no application runtime. `index.ts` is boilerplate from `bun init` and is
unused. All real work is HTML email markup.

## Repository layout

```
01.html                     Reference: first draft (local ./images, simple tables)
02.html                     Reference: Mailchimp export of the same content.
                            ❌ NOT Outlook-safe (uses <button>, class-based CSS)
03.html                     Reference: canonical production markup (Outlook-safe)
editions/<edition>/         One folder per issue (e.g. kabar-inklusi-10)
  edition.json              All text, links, colors, image filenames for that issue
  images/                   That issue's local image assets
templates/
  base.html                 The Outlook-safe layout, with placeholders + loops
  partials/                 Reusable snippets (buttons)
scripts/
  build.ts                  Render an edition -> dist/<edition>/
  validate.ts               Enforce Outlook-safety + asset checks
  deploy.ts                 build + validate + zip
  extract_images.py         Slice PNGs into an edition's images/ from crops.json
0[1-3].html                 (references — do not delete)
images/                     Legacy shared assets (from 01.html draft)
dist/, dist.zip             Generated output (gitignored)
```

`01.html` / `02.html` / `03.html` are kept as historical references. **Do not
delete them and do not treat them as build inputs.** The build input is
`templates/base.html` + `editions/<edition>/edition.json`.

## Commands

```bash
bun install                              # install devDeps (bestzip, http-server)
bun run build                            # build the default edition (package.json "edition")
bun run build -- kabar-inklusi-10         # build a specific edition
bun run validate                         # check the built output
bun run deploy                           # build + validate + zip into dist/<edition>.zip
bun run dev                              # http-server, opens dist/<edition>/index.html
bun run extract -- editions/<edition>/crops.json   # optional: slice source PNGs into images/
```

`bun run build` writes `dist/<edition>/index.html` and copies that edition's
`images/` next to it. The output uses **relative** image paths, so the folder and
the zip are self-contained.

## Adding a new edition (issue)

1. Copy the previous edition: `cp -r editions/kabar-inklusi-10 editions/kabar-inklusi-11`.
2. Drop new images into `editions/kabar-inklusi-11/images/`. If you only have a
   combined sheet/export, put it in `editions/<edition>/source/`, add a
   `crops.json` (source + x0/y0/x1/y1 per output file), then run
   `bun run extract -- editions/<edition>/crops.json`. Crops are RGBA by
   default: near-white background touching the crop border is made transparent
   (flood fill) so rounded photos/covers blend onto colored backgrounds — set
   `"transparent": false` globally or per crop for full-bleed photos.
3. Edit `editions/kabar-inklusi-11/edition.json` — subject, stories, links, image filenames.
4. Point `package.json` `"edition"` at it (or run `bun run build -- kabar-inklusi-11`).
5. `bun run deploy`.

**Never edit `templates/base.html` to change content or wording.** Content lives
only in `edition.json`. The template changes only when the *design* changes.

## Outlook / email-client compatibility rules (NON-NEGOTIABLE)

Any change to `templates/base.html` or `templates/partials/` must preserve these.
`scripts/validate.ts` fails the build if key ones are broken.

- **Layout with tables only.** Use nested
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0">`.
  No `<button>`, no flexbox, no CSS grid, no `<div>`-based layout.
- **Critical styles are inline.** No external stylesheets, no `<style>`-only
  layout. The `<style>` block is only for the mobile media query.
- Every layout table carries `mso-table-lspace:0pt; mso-table-rspace:0pt`.
- **Colors are set twice:** as a `bgcolor="..."` attribute *and* as an inline
  `background-color:...` (Outlook needs `bgcolor`; modern clients need the CSS).
- **Buttons** are a `table > tr > td[bgcolor]` with `mso-padding-alt` wrapping an
  `<a>` (see `templates/partials/cta-*.html`). Never `<button>` or bare `<a>`.
- **Two-column blocks** use `display:inline-block` tables + a
  `<!--[if mso]>` fixed-width fallback table + a media query class for stacking.
  Keep the `<!--[if mso]> ... <![endif]-->` wrappers intact.
- Keep `<!--[if gte mso 15]><o:OfficeDocumentSettings><o:AllowPNG/>…
  <o:PixelsPerInch>96</o:PixelsPerInch>` in `<head>`.
- Keep `mso-line-height-rule:exactly` on text and
  `-ms-interpolation-mode:bicubic` on images.
- Images always have a `width` attribute **and** inline `max-width` + `height:auto;
  border:0;`. Container width is **660px**.
- Keep the Mailchimp merge tags: `*|MC:SUBJECT|*` in `<title>` and `*|ARCHIVE|*`
  in the footer "view in browser" link.
- Fonts: `Arial, Helvetica, sans-serif` only.

## Template syntax (built-in, no dependencies)

`scripts/build.ts` implements a tiny Mustache subset:

| Syntax | Meaning |
|--------|---------|
| `{{key}}` / `{{a.b}}` | Insert value (raw, not escaped). Looked up through parent scopes. |
| `{{#key}} … {{/key}}` | Section. Arrays repeat the block; truthy objects render once; falsy/empty renders nothing. |
| `{{^key}} … {{/key}}` | Inverted section — renders when falsy or empty. |
| `{{> name}}` | Include `templates/partials/name.html`, rendered with the current context. |

Inside an array section each item also gets `first`, `last`, `index` (1-based),
`count` injected.

## Editing `edition.json`

- `images` paths are filenames resolved against the edition's `images/` folder —
  build rewrites them to `images/<file>`.
- `products[].band` groups products into the yellow highlight band (`true`) or
  plain white rows (`false`). Keep band items before plain items.
- Stories carry their own `theme` color key (from `colors`) and `textColor`.
- Body text may contain inline HTML (`<strong>`, quotes, emoji) — it is inserted raw.
