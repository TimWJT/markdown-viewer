# Markdown Viewer

A markdown **viewer**. Not an editor, not a vault, not a note system. It renders a `.md` file, lets you zoom, and stays out of the way.

The whole UI is one self-contained HTML file — parser, sanitiser, syntax highlighting, math and styles all inlined. No network requests, ever. Your files never leave the machine.

## Download

### [→ Download the latest version](https://github.com/TimWJT/markdown-viewer/releases/latest)

On that page, open **Assets** and pick **one** file — the rest can be ignored:

| Your computer | Download the file ending in |
|---------------|-----------------------------|
| **Windows** | **`_x64-setup.exe`** |
| **Mac with Apple silicon** (M1, M2, M3, M4…) | **`_aarch64.dmg`** |
| **Mac with Intel** | **`_x64.dmg`** |
| **Linux** (Ubuntu, Debian, Mint) | **`.deb`** |
| **Linux** (any other) | **`.AppImage`** |
| **No install** — runs in any browser | **`Markdown.Viewer.html`** (532 KB) |

Not sure which Mac you have? Apple menu → **About This Mac**. "Chip: Apple M…" means Apple silicon; "Processor: Intel" means Intel.

The other files are for special cases: `.msi` and `.rpm` are alternative installers for people who specifically need them, and `.app.tar.gz` / `.sig` files are used by the built-in updater — you never need to download those.

Once installed, double-clicking any `.md` file opens it here.

### "Windows protected your PC"?

That's expected. The app is free and not code-signed, so Windows doesn't recognise the publisher. It is safe to install:

1. Click **More info** (small text under the message).
2. Click **Run anyway**.
3. The normal setup wizard opens. You only see this once.

**macOS:** right-click the app, choose **Open**, then confirm. See [Code signing](#code-signing) for why this happens.

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
| **Print** | `Ctrl`+`P` opens the native print dialog, so you can print or save a PDF. Print styles strip the toolbar, tab strip and Find box, keep code blocks and tables whole, and keep headings off the bottom of a page. On macOS and Linux that dialog is the real system one; on Windows it is WebView2's own print dialog, which is newer and has not yet been run on a real Windows machine. |
| **Code** | Syntax highlighting for ~40 common languages, hover a block to copy it. |
| **Find** | `Ctrl`+`F` searches the document, with match counts and wrap-around navigation. The webview has no find of its own, so this is the only way to search in the app. |
| **Front matter** | YAML/TOML blocks are stripped instead of rendering as a stray rule and a bogus heading. |
| **Local images** | Relative image paths resolve against the document folder, for documents you keep inside your own user profile. The app is not allowed to read images from anywhere else on the machine, so an image beside a document on a USB stick or a network drive will not show. |
| **Links** | External links open in your real browser, not inside the app window. |
| **Window** | Size and position are remembered between launches. |
| **Math** | LaTeX renders via Temml to MathML, which the browser draws natively — no font files to ship. |
| **Diagrams** | Mermaid diagrams render in the installed app (see the note below). |
| **Footnotes** | GFM-style `[^1]` footnotes with back-references. |
| **Tabs** | Open documents sit in a tab strip, each keeping its own scroll position. The strip hides itself when only one document is open. |
| **Tab or window** | A setting decides whether an opened file joins this window as a tab or gets a window of its own. |
| **Folder navigation** | `[` and `]` step through the markdown files in the same folder. |
| **Fit width** | One click scales the document to exactly fill the window. |
| **Reading time** | Word count and estimated minutes in the toolbar. |

Opens files by drag-and-drop, the Open button, or pasting markdown straight from the clipboard. Starts clean: the app does not put your last files back on its own. `Ctrl`+`Shift` `T` brings back the last group of tabs you closed, and turning on **Reopen tabs from last time** in Settings does it for you at every launch.

## Keyboard

| Key | Action |
|-----|--------|
| `Ctrl` `O` | Open a file |
| `Ctrl` `+` / `Ctrl` `-` | Zoom in / out |
| `Ctrl` `0` | Reset zoom to 100% |
| `Ctrl` `9` | Fit width |
| `[` / `]` | Previous / next file in the folder |
| `Ctrl` `Tab` | Next tab (`Shift` for previous) |
| `Ctrl` `PgDn` / `Ctrl` `PgUp` | Next / previous tab |
| `Ctrl` `1`–`8` | Jump to tab |
| `Ctrl` `W` | Close tab, or the whole window — see settings |
| `Ctrl` `Shift` `W` | Close the window and all its tabs |
| `Ctrl` `Shift` `T` | Reopen the last closed tab, window, or previous session (desktop only) |
| `o` | Toggle outline |
| `t` | Cycle theme |
| `w` | Cycle reading width |
| `f` | Toggle sans / serif |
| `Ctrl` `F` | Find in document |
| `F3` | Next match |
| `F5` | Force reload from disk |
| `Ctrl` `R` | Force reload from disk (same as `F5`) |
| `,` | Open settings |
| `Esc` | Close find or settings |
| `Ctrl` `P` | Print or save as PDF |

Two notes on the table. `Ctrl` `Tab` and `Ctrl` `PgDn` / `Ctrl` `PgUp` are in the
handler, but macOS captures those three before the app ever sees them — they are
in the table for parity and do nothing on a Mac. And `Ctrl` `Shift` `T` is
desktop-only: in the browser builds there is no closed-tab history to restore, so
the key does nothing there.

## Settings

The gear button (or `,`) opens a small panel. Everything applies live and persists.

| Setting | Default | Range |
|---------|---------|-------|
| **Zoom speed** | 1.0× (~25% per wheel notch) | 0.25× – 4× (~6% – ~180%) |
| **Text size** | 17px | 13 – 26px |
| **Line height** | 1.68 | 1.3 – 2.1 |
| **Invert zoom direction** | off | scroll down zooms in |
| **Open files in** | New tab | new tab / new window |
| **Ctrl+W closes** | This tab | this tab / all tabs |
| **Reopen tabs from last time** | off | on: restore every window's tabs at startup |
| **Check for updates on startup** | on | off: only check when you ask |
| **Updates** | — | Check for updates |

## Updates

The desktop app checks GitHub for a new release about three seconds after launch, at
most once every six hours, and only while **Check for updates on startup** is on.
If one exists, a bar appears at the bottom of the window offering to install it —
nothing is downloaded until you click **Update**.
**Later** dismisses that version until the next one ships. Settings has a
**Check for updates** button for checking on demand, and shows the version you
are running.

Update packages are signed with a minisign key; the app refuses any manifest it
cannot verify against the public key baked into `tauri.conf.json`. The private
key lives in the `TAURI_SIGNING_PRIVATE_KEY` repository secret and is only used
by the release workflow.

The standalone HTML build has nothing to update, so the setting is hidden there.

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

**The installed app** — everything works, including `.md` file association, live reload, `Ctrl` `Shift` `T`, and restoring tabs at startup if you turn that on in Settings.

**Served over `http://` (`npm start`)** — everything works too. This is the development loop.

**Double-clicking `Markdown Viewer.html`** — rendering, zoom, themes and settings all work. Browsers restrict some APIs on `file://` origins, so live reload and the closed-tab history behind `Ctrl` `Shift` `T` are unavailable. Opening files still works via the Open button and drag-and-drop.

## Project layout

```
src/index.html       markup + toolbar, with __CSS__ / __JS__ injection points
src/startup.js       early theme apply, runs before the stylesheet
src/app.css          design tokens, prose styles, syntax colours, print rules
src/main.js          all app logic (browser and native share this file)
src/mermaid-entry.js its own bundle, fetched on demand
build.mjs            bundles + inlines everything into one HTML file
serve.mjs            dev-only static server
tests/               node --test suite, run against the real src/main.js
dist/                index.html + startup.js + app.css + app.js + mermaid.js
                     (what Tauri bundles, and all it bundles)
dist-standalone/     Markdown Viewer.html — the single-file download, built
                     outside dist/ so it never ships inside the installer
src-tauri/           the native shell
  src/main.rs        seven commands: read a path, stat it, list its siblings,
                     hand over argv[1] from a file-association launch, hand a
                     file to a second window that asked for it, tell a window
                     no external open is waiting, and open the WebView2 print
                     dialog on Windows
  tauri.conf.json    window, bundle targets, .md file association
  capabilities/      permissions granted to the window
assets/icon.svg      source art for every generated icon
.github/workflows/   tags -> installers for all platforms, on a draft release
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

CI runs the test suite (`npm test`) and then builds Windows, macOS (both
architectures) and Linux installers, plus the standalone HTML, and attaches them
to a **draft** release. Review it on the Releases page and hit publish — nothing
is ever published without you doing it. Running the workflow by hand from a
branch still builds and tests, but attaches nothing, so a stray manual run
cannot cut a release.

## Code signing

The installers are unsigned, which is why first launch shows a warning. Removing it costs real money and is not worth it for most projects:

- **Windows** — an OV code-signing certificate runs roughly $200–400/year, and SmartScreen still distrusts a new certificate until it accrues download reputation. Since 2024 an EV certificate no longer skips that wait, so it buys nothing extra.
- **macOS** — requires the Apple Developer Program at $99/year, after which the app can be signed and notarised and launches with no warning at all.

If you ever buy certificates, they slot into the existing workflow as repository secrets — `tauri-action` reads them without any change to the build itself.

## A note on Mermaid

Mermaid is 3.4 MB bundled — more than six times the rest of the app. Inlining it would mean parsing 3.4 MB of JavaScript at every launch for documents that mostly contain no diagrams, so it is built as a separate `mermaid.js` fetched only when a document actually has one.

The practical consequence: **the installed app renders Mermaid; the standalone HTML file does not.** In the standalone build the fetch fails and a diagram stays a syntax-highlighted code block that says diagrams are not supported there, rather than looking broken. That keeps the promise the standalone build exists for — one file, no siblings, no network.

Math and footnotes are inlined in both, costing about 210 KB together.

## Deliberately not included

Editing, file trees, search across files, sync, plugins, wiki-links, graph view. Those are what make the other tools heavy. If you need them, use Obsidian.

## License

Free for personal and other noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may modify it and share your changes, but you may not use it to make money. For commercial use, contact [@TimWJT](https://github.com/TimWJT) for a commercial license.
