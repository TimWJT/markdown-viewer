# Markdown Viewer

A markdown **viewer**. Not an editor, not a vault, not a note system. It renders a `.md` file, lets you zoom, and stays out of the way.

The whole UI is one self-contained HTML file — parser, sanitiser, syntax highlighting, math and styles all inlined. No network requests, ever. Your files never leave the machine.

## Download

Grab an installer from the [Releases page](../../releases):

| Platform | File | Size |
|----------|------|------|
| Windows | `Markdown Viewer_x64-setup.exe` | 2.3 MB |
| macOS (Apple silicon) | `Markdown Viewer_aarch64.dmg` | ~6 MB |
| macOS (Intel) | `Markdown Viewer_x64.dmg` | ~6 MB |
| Linux | `.deb` / `.AppImage` | ~6 MB |
| Any browser | `Markdown Viewer.html` | 505 KB, no install |

Once installed, double-clicking any `.md` file opens it here.

> **First launch shows a warning.** The builds are not code-signed, so Windows SmartScreen says the publisher is unknown — click **More info → Run anyway**. On macOS, right-click the app and choose **Open**, then confirm. See [Code signing](#code-signing) for what it would take to remove this.

## Run from source

```bash
npm install
npm start
```

Then open <http://localhost:4173>. That serves the web build — the fastest loop for working on the UI.

To build the desktop app:

```bash
npm run app:build
```

Installers land in `src-tauri/target/release/bundle/`. `npm run app:dev` runs it with hot reload.

## What it does

| | |
|---|---|
| **Zoom** | Continuous scale transform, like browser pinch-zoom: no reflow, GPU-composited. Pinch, `Ctrl`+scroll, `Ctrl` `+`/`-`, or the toolbar. Persists between sessions. |
| **Pan** | Once zoomed past the viewport, drag with the middle mouse button or `Alt`+drag. Plain left-drag still selects text. |
| **Live reload** | Edit the file in any editor and the view updates in under a second. Scroll position is kept. |
| **Themes** | Auto (follows OS), light, dark. |
| **Outline** | Sidebar built from headings, highlights the section you're reading. |
| **Reading width** | Normal / wide / full-bleed. |
| **Serif mode** | Switch to a serif face for long reading. |
| **Print** | `Ctrl`+`P` gives clean PDF output with sensible page breaks. |
| **Code** | Syntax highlighting for ~40 common languages, hover a block to copy it. |
| **Find** | `Ctrl`+`F` searches the document, with match counts and wrap-around navigation. The webview has no find of its own, so this is the only way to search in the app. |
| **Front matter** | YAML/TOML blocks are stripped instead of rendering as a stray rule and a bogus heading. |
| **Local images** | Relative image paths resolve against the document folder. |
| **Links** | External links open in your real browser, not inside the app window. |
| **Window** | Size and position are remembered between launches. |
| **Math** | LaTeX renders via Temml to MathML, which the browser draws natively — no font files to ship. |
| **Diagrams** | Mermaid diagrams render in the installed app (see the note below). |
| **Footnotes** | GFM-style `[^1]` footnotes with back-references. |
| **Recent files** | Dropdown beside Open, in the installed app. |
| **Folder navigation** | `[` and `]` step through the markdown files in the same folder. |
| **Fit width** | One click scales the document to exactly fill the window. |
| **Reading time** | Word count and estimated minutes in the toolbar. |

Opens files by drag-and-drop, the Open button, or pasting markdown straight from the clipboard. Reopens the last file you were reading on launch.

## Keyboard

| Key | Action |
|-----|--------|
| `Ctrl` `O` | Open a file |
| `Ctrl` `+` / `Ctrl` `-` | Zoom in / out |
| `Ctrl` `0` | Reset zoom to 100% |
| `Ctrl` `9` | Fit width |
| `[` / `]` | Previous / next file in the folder |
| `o` | Toggle outline |
| `t` | Cycle theme |
| `w` | Cycle reading width |
| `f` | Toggle sans / serif |
| `Ctrl` `F` | Find in document |
| `F3` | Next match |
| `F5` | Force reload from disk |
| `,` | Open settings |
| `Esc` | Close find or settings |
| `Ctrl` `P` | Print or save as PDF |

## Settings

The gear button (or `,`) opens a small panel. Everything applies live and persists.

| Setting | Default | Range |
|---------|---------|-------|
| **Zoom speed** | 1.0× (~25% per wheel notch) | 0.25× – 4× (~6% – ~180%) |
| **Text size** | 17px | 13 – 26px |
| **Line height** | 1.68 | 1.3 – 2.1 |
| **Invert zoom direction** | off | scroll down zooms in |

Zoom speed scales the exponent applied to wheel deltas, so it affects both the mouse wheel and trackpad pinch proportionally — pinch stays smooth at any setting because it arrives as many small deltas. The panel shows the resulting per-notch percentage as you drag the slider.

## Mouse and trackpad

| Gesture | Action |
|---------|--------|
| Pinch (trackpad) | Smooth zoom, anchored under the cursor |
| `Ctrl` + scroll | Zoom, anchored under the cursor |
| Middle-drag, or `Alt` + drag | Pan in any direction |
| `Shift` + scroll | Pan horizontally |
| Two-finger swipe | Pan in any direction |
| Left-drag | Select text (never pans) |

### Why zoom works this way

The first version scaled `font-size`, which reflows the text at every step — that reads as a jumpy, un-browser-like stutter, and because reflowed text always fits the column there is never anything to pan to.

Zoom is now a CSS `transform: scale()` on the document, with a sibling element reserving the scaled box so the scroll container gets genuine scrollbars on both axes. That is what browser pinch-zoom does: layout happens once, the compositor scales the result, line breaks never move, and once the page is wider than the window you can pan around it.

## Three ways to run it

**The installed app** — everything works, including `.md` file association, live reload, and reopening the last file on launch.

**Served over `http://` (`npm start`)** — everything works too. This is the development loop.

**Double-clicking `Markdown Viewer.html`** — rendering, zoom, themes and settings all work. Browsers restrict some APIs on `file://` origins, so live reload and "reopen last file" may be unavailable. Opening files still works via the Open button and drag-and-drop.

## Project layout

```
src/index.html       markup + toolbar, with __CSS__ / __JS__ injection points
src/app.css          design tokens, prose styles, syntax colours, print rules
src/main.js          all app logic (browser and native share this file)
src/mermaid-entry.js its own bundle, fetched on demand
build.mjs            bundles + inlines everything into one HTML file
serve.mjs            dev-only static server
dist/                index.html + app.css + app.js  (what Tauri bundles)
                     Markdown Viewer.html            (standalone, all inlined)
                     mermaid.js                      (lazy, app only)
src-tauri/           the native shell
  src/main.rs        four commands: read a path, stat it, list its siblings,
                     and hand over argv[1] from a file-association launch
  tauri.conf.json    window, bundle targets, .md file association
  capabilities/      permissions granted to the window
assets/icon.svg      source art for every generated icon
.github/workflows/   tags -> installers for all platforms
```

The frontend is platform-agnostic: `main.js` checks for `window.__TAURI_INTERNALS__`
and uses native file commands when present, browser APIs when not. There is no
separate desktop codebase.

Rebuild after any change to `src/`:

```bash
npm run build
```

## Releasing

```bash
git tag v1.0.0
git push origin v1.0.0
```

CI builds Windows, macOS (both architectures) and Linux installers, plus the
standalone HTML, and attaches them to a **draft** release. Review it on the
Releases page and hit publish.

## Code signing

The installers are unsigned, which is why first launch shows a warning. Removing it costs real money and is not worth it for most projects:

- **Windows** — an OV code-signing certificate runs roughly $200–400/year, and SmartScreen still distrusts a new certificate until it accrues download reputation. An EV certificate (~$300–600/year, hardware token) skips the reputation wait.
- **macOS** — requires the Apple Developer Program at $99/year, after which the app can be signed and notarised and launches with no warning at all.

If you ever buy certificates, they slot into the existing workflow as repository secrets — `tauri-action` reads them without any change to the build itself.

## A note on Mermaid

Mermaid is 3.4 MB bundled — more than ten times the rest of the app. Inlining it would mean parsing 3.4 MB of JavaScript at every launch for documents that mostly contain no diagrams, so it is built as a separate `mermaid.js` fetched only when a document actually has one.

The practical consequence: **the installed app renders Mermaid; the standalone HTML file does not.** In the standalone build the fetch simply fails and a diagram stays a syntax-highlighted code block. That keeps the promise the standalone build exists for — one file, no siblings, no network.

Math and footnotes are inlined in both, costing about 210 KB together.

## Deliberately not included

Editing, file trees, tabs, search across files, sync, plugins, wiki-links, graph view. Those are what make the other tools heavy. If you need them, use Obsidian.
