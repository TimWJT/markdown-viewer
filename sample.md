# Markdown Viewer

A single HTML file that renders markdown and gets out of the way. **No editor, no vault, no plugins.**

## Why this exists

The good pure-viewer apps are macOS only, and everything on Windows is an editor wearing a viewer costume. This is just the reading half.

> Rendering markdown is a commodity. Nobody can charge for it, so nobody polishes it.
> That's the whole gap.

## Features

- Zoom that **persists** between sessions
- Live reload — edit in any editor, the view updates
- Light / dark / auto theme
- Outline sidebar with scroll tracking
- Print to PDF with sane page breaks

### Task list

- [x] Drag and drop
- [x] Clipboard paste
- [ ] Mermaid diagrams
- [ ] Math rendering

## Code

```js
const STEPS = [50, 60, 70, 80, 90, 100, 125, 150, 200, 300];

function zoomStep(dir) {
  let i = STEPS.findIndex((s) => s >= zoom);
  if (i === -1) i = STEPS.length - 1;
  return STEPS[Math.max(0, Math.min(i + dir, STEPS.length - 1))];
}
```

```python
def slugify(text: str) -> str:
    """Turn a heading into an anchor id."""
    return "-".join(text.lower().split())
```

Inline `code` sits inside a sentence without breaking the line rhythm.

## Table

| Approach | Size | File association | Offline |
|----------|------|------------------|---------|
| Browser extension | ~1 MB | no | yes |
| This file | 256 KB | not yet | yes |
| Tauri wrapper | ~5 MB | yes | yes |
| Electron | ~150 MB | yes | yes |

## Keyboard

Press <kbd>t</kbd> to cycle the theme, <kbd>o</kbd> for the outline, <kbd>w</kbd> for width, and <kbd>f</kbd> to switch to a serif face for long reading.

### Nested lists

1. First
   - nested bullet
   - another one
     1. deeper
2. Second
3. Third

---

Links go [somewhere useful](https://commonmark.org) and open in a new tab.
