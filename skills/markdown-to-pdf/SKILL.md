---
name: markdown-to-pdf
description: Use when asked to turn a Markdown file into a PDF, export a .md report for printing or sharing, or produce a printable deliverable from Markdown, especially documents containing mermaid diagrams, wide tables, or that need page numbers and a running header.
---

# Markdown to PDF

## Overview

Renders a Markdown file to a print-quality PDF via headless Chromium. Mermaid
diagrams come out as **vector SVG**, tables repeat their header row across page
breaks, and every page gets a running header and `Page N of M` footer.

Oversized diagrams are the hard part, and the script handles them: a diagram
taller than the page is sliced across consecutive pages, and one far wider than
the page is wrapped into stacked left-to-right bands. Both keep labels readable
instead of shrinking the figure into an unreadable sliver.

Nothing is uploaded. Rendering is local.

## Usage

```bash
node ~/.claude/skills/markdown-to-pdf/md2pdf.js <input.md> [output.pdf] [options]
```

Use the path where the skill is installed if it is not under `~/.claude/skills`.

Output defaults to the input path with `.pdf` substituted. Options:

| Option | Effect |
|---|---|
| `--note "TEXT"` | Right-hand running-header text (e.g. a status or confidentiality caveat) |
| `--format Letter\|A4` | Paper size (default `Letter`) |
| `--landscape` | Landscape orientation |

The document title (browser tab, PDF metadata, left-hand running header) comes
from the first `#` heading, falling back to the filename.

The script prints a line per oversized diagram saying how it was handled. Relay
anything still flagged as too small to the user.

First run installs `markdown-it`, `mermaid`, and `playwright-core` into the skill
directory automatically. Chromium is auto-detected from the Playwright cache, then
system Chrome/Chromium; override with `CHROME_PATH`.

## After rendering, always verify

The command exits non-zero if a diagram fails, but it cannot see layout problems.
Render pages to images and look at them:

```bash
pdftoppm -png -r 75 out.pdf /tmp/preview/p    # then Read the PNGs
```

Check: no diagram clipped at a page edge, no table or code block running off the
right margin, no page of pure whitespace (a blank page means content was clipped,
not merely pushed). Report the page count to the user.

## Design notes (why it is built this way)

Each of these fixes a bug that is invisible until you look at rendered pages:

- **Chrome clips; it does not slice or scroll.** Anything overflowing the print
  margin box is silently cut: an SVG taller than the page loses its lower half,
  a long code line loses its right end. Hence `white-space: pre-wrap` on `pre`,
  and the diagram slicing/banding rather than plain scaling.
- **Page margins are 6 mm; `<main>` is padded 10 mm.** Body text keeps a readable
  measure while `.mermaid-slot` uses negative margins to reach nearly the full
  sheet. A diagram cannot be given more room by breaking out *past* the margins,
  because that region is clipped, so the margins themselves have to be narrow.
- **Mermaid's inline `width`/`max-width` are stripped after render.** Mermaid
  writes them on the `<svg>`, where they outrank the stylesheet and let wide
  flowcharts run off the page. The script removes them and scales via the viewBox.
- **The viewport is set to the printed diagram width** so mermaid measures label
  wrapping at the width the diagram will occupy in print.
- **Slices and bands overlap** (36 px / 110 px) so a node cut by a seam reappears
  whole on the adjacent slice.
- **`thead { display: table-header-group }`** repeats table headers on
  continuation pages; `tr { break-inside: avoid }` stops rows splitting mid-cell.

## Common problems

| Symptom | Cause / fix |
|---|---|
| Diagram cut off at a page edge | Inline SVG sizing survived, or margins were widened. See design notes. |
| Blank page containing only a faint box | A diagram overflowed and was clipped; the slicing threshold did not trigger. |
| Diagram still flagged too small | Dense and neither tall nor wide enough to band. It is vector, so it zooms; for print, try `--landscape` or ask whether the diagram can be split at the source. |
| Large blank gap before a diagram | A diagram that will not fit is pushed whole to the next page. Expected. |
| Source file changed mid-build | `stat` the `.md` against the `.pdf` afterwards; rerun if it moved. |

## Styling

`report.css` holds the print stylesheet: serif body, sans headings and tables,
navy accent, banded rows, callout styling for blockquotes. Edit it to restyle;
it applies to every document rendered by this skill.
