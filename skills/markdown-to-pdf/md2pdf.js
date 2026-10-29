#!/usr/bin/env node
// Render a Markdown file to a print-quality PDF, with mermaid diagrams drawn as
// vector SVG. Usage: node md2pdf.js <input.md> [output.pdf] [options]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SKILL_DIR = __dirname;
const DEPS = ['markdown-it', 'mermaid', 'playwright-core'];

// Letter/A4 at 96 CSS px per inch. Side margins are deliberately narrow so wide
// diagrams can reach the paper edge; report.css pads <main> back to a readable
// measure. Chrome clips anything that spills outside the margin box, so the
// diagram break-out has to live inside these margins rather than fight them.
const PAGE_SIZES = {
  Letter: { width: 816, height: 1056 },
  A4: { width: 794, height: 1123 },
};
const SIDE_MARGIN_MM = 6;
const VERTICAL_MARGIN_MM = 18;
// Below this scale, diagram labels are too small to read on paper (still
// zoomable, since the output is vector) and the user should be told.
const LEGIBLE_SCALE = 0.3;
// Scale a wide diagram is wrapped into bands to reach, and the band ceiling.
const TARGET_SCALE = 0.45;
const MAX_BANDS = 6;

function parseArgs(argv) {
  const positional = [];
  const opts = { format: 'Letter', note: '', landscape: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--note') opts.note = argv[++i] || '';
    else if (arg === '--format') opts.format = argv[++i] || 'Letter';
    else if (arg === '--landscape') opts.landscape = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (!positional[0]) throw new Error('usage: md2pdf.js <input.md> [output.pdf] [--note TEXT] [--format Letter|A4] [--landscape]');
  if (!PAGE_SIZES[opts.format]) throw new Error(`--format must be one of: ${Object.keys(PAGE_SIZES).join(', ')}`);
  opts.input = path.resolve(positional[0]);
  opts.output = path.resolve(positional[1] || opts.input.replace(/\.md$/i, '') + '.pdf');
  return opts;
}

// Install the render dependencies into the skill directory on first use. Plain
// `npm install` keeps the versions pinned in package.json and package-lock.json;
// naming the packages would fetch their latest releases instead.
function ensureDeps() {
  const missing = DEPS.filter(d => !fs.existsSync(path.join(SKILL_DIR, 'node_modules', d)));
  if (missing.length === 0) return;
  console.error(`installing render dependencies (${missing.join(', ')})`);
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], {
    cwd: SKILL_DIR, stdio: 'inherit'
  });
}

function newestPlaywrightChrome() {
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  const macCache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const root = fs.existsSync(cache) ? cache : macCache;
  if (!fs.existsSync(root)) return null;
  const builds = fs.readdirSync(root)
    .filter(d => d.startsWith('chromium-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const relatives = [
    'chrome-linux64/chrome', 'chrome-linux/chrome',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const build of builds) {
    for (const rel of relatives) {
      const candidate = path.join(root, build, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const fromPlaywright = newestPlaywrightChrome();
  if (fromPlaywright) return fromPlaywright;
  const systemPaths = [
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = systemPaths.find(p => fs.existsSync(p));
  if (found) return found;
  throw new Error(
    'no Chromium found. Install one with `npx playwright install chromium` ' +
    'or point CHROME_PATH at an existing Chrome/Chromium binary.'
  );
}

// Mermaid fences are pulled out before markdown rendering so markdown-it does
// not escape their contents; each leaves a placeholder filled in by the browser.
function extractDiagrams(markdown) {
  const diagrams = [];
  const withPlaceholders = markdown.replace(/^```mermaid\n([\s\S]*?)^```/gm, (_match, body) => {
    diagrams.push(body);
    return `<div class="mermaid-slot" data-index="${diagrams.length - 1}"></div>`;
  });
  return { diagrams, withPlaceholders };
}

function documentTitle(markdown, inputPath) {
  const heading = markdown.match(/^#\s+(.+)$/m);
  return heading
    ? heading[1].replace(/[*`_]/g, '').trim()
    : path.basename(inputPath, path.extname(inputPath));
}

function buildHtml({ markdown, inputPath }) {
  const MarkdownIt = require(path.join(SKILL_DIR, 'node_modules', 'markdown-it'));
  const { diagrams, withPlaceholders } = extractDiagrams(markdown);
  const body = new MarkdownIt({ html: true, linkify: false, typographer: false }).render(withPlaceholders);
  const mermaidJs = fs.readFileSync(path.join(SKILL_DIR, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'), 'utf8');
  const css = fs.readFileSync(path.join(SKILL_DIR, 'report.css'), 'utf8');
  const title = documentTitle(markdown, inputPath);

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${css}</style></head>
<body><main>${body}</main>
<script>${mermaidJs}</script>
<script>
const sources = ${JSON.stringify(diagrams)};
const TARGET_SCALE = ${TARGET_SCALE};
const MAX_BANDS = ${MAX_BANDS};
mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  themeVariables: {
    fontFamily: 'Inter, Helvetica, Arial, sans-serif',
    fontSize: '15px',
    primaryColor: '#eef2f7',
    primaryTextColor: '#1a2433',
    primaryBorderColor: '#8fa3bd',
    lineColor: '#5b6b80',
    tertiaryColor: '#f7f9fc'
  },
  flowchart: { htmlLabels: true, useMaxWidth: false, curve: 'basis',
    nodeSpacing: 36, rankSpacing: 46, diagramPadding: 6 }
});
// Fit every diagram inside the printable page box. Chrome CLIPS an SVG taller
// than the page rather than slicing it across pages, so a diagram that is not
// height-constrained here silently loses its lower half.
window.renderAll = async (pageHeightPx) => {
  const slots = [...document.querySelectorAll('.mermaid-slot')];
  const report = [];
  for (const slot of slots) {
    const i = Number(slot.dataset.index);
    const { svg } = await mermaid.render('mmd' + i, sources[i]);
    slot.innerHTML = svg;
    // Mermaid writes inline width/max-width that outrank the stylesheet and let
    // wide diagrams run off the page. Drop them and scale via the viewBox.
    const el = slot.querySelector('svg');
    const box = el.viewBox.baseVal;
    el.removeAttribute('width');
    el.removeAttribute('height');
    el.style.cssText = 'width:100%;max-width:100%;height:auto;';

    const available = slot.clientWidth;
    const widthFit = available / box.width;
    const heightFit = pageHeightPx / box.height;

    // A tall diagram squeezed to one page loses most of its legibility. Slice it
    // into page-height windows instead, each its own unbreakable block.
    if (widthFit > heightFit * 1.5) {
      const slices = sliceIntoPages(slot, el, box.height * widthFit, pageHeightPx);
      report.push({ index: i, scale: widthFit, w: box.width, h: box.height, slices });
      continue;
    }

    // A diagram far wider than the page, shrunk to the column, becomes an illegible
    // sliver. Cut it into left-to-right bands stacked down the page instead.
    if (widthFit < TARGET_SCALE && box.width / box.height > 3) {
      const scale = widthFit * Math.min(MAX_BANDS, Math.ceil(TARGET_SCALE / widthFit));
      if (box.height * scale <= pageHeightPx) {
        const bands = wrapIntoBands(slot, el, box.width * scale, available);
        report.push({ index: i, scale, w: box.width, h: box.height, slices: 1, bands });
        continue;
      }
    }

    const width = Math.min(available, box.width * heightFit);
    if (width < available) el.style.width = Math.floor(width) + 'px';
    report.push({ index: i, scale: width / box.width, w: box.width, h: box.height, slices: 1, bands: 1 });
  }
  return report;
};

// Repeat the diagram inside full-width windows, each showing a different
// horizontal band, read top to bottom. Overlap keeps seam-cut nodes readable.
function wrapIntoBands(slot, svg, displayWidth, windowWidth) {
  // Wide enough that a node cut by one seam reappears whole on the next band.
  const OVERLAP = 110;
  const step = windowWidth - OVERLAP;
  const count = Math.ceil((displayWidth - OVERLAP) / step);
  const markup = svg.outerHTML;
  slot.innerHTML = '';
  slot.classList.add('banded');
  for (let k = 0; k < count; k++) {
    const offset = k * step;
    const band = document.createElement('div');
    band.className = 'diagram-band';
    band.style.width = Math.min(windowWidth, displayWidth - offset) + 'px';
    band.innerHTML = markup;
    const inner = band.querySelector('svg');
    inner.style.cssText = 'width:' + Math.round(displayWidth) + 'px;max-width:none;height:auto;';
    inner.style.marginLeft = -offset + 'px';
    slot.appendChild(band);
  }
  return count;
}

// Repeat the diagram inside fixed-height clipping windows, each showing a
// different vertical band. A small overlap keeps a node cut by a seam readable
// on one side or the other.
function sliceIntoPages(slot, svg, displayHeight, pageHeight) {
  const OVERLAP = 36;
  const step = pageHeight - OVERLAP;
  const count = Math.ceil((displayHeight - OVERLAP) / step);
  const markup = svg.outerHTML;
  slot.innerHTML = '';
  slot.classList.add('sliced');
  for (let k = 0; k < count; k++) {
    const offset = k * step;
    const window = document.createElement('div');
    window.className = 'diagram-slice';
    window.style.height = Math.min(pageHeight, displayHeight - offset) + 'px';
    window.innerHTML = markup;
    const inner = window.querySelector('svg');
    inner.style.cssText = 'width:100%;max-width:100%;height:auto;';
    inner.style.marginTop = -offset + 'px';
    slot.appendChild(window);
  }
  return count;
}
</script>
</body></html>`;
  return { html, title, diagramCount: diagrams.length };
}

function escapeHtml(text) {
  return text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function chromeMargin() {
  return {
    top: `${VERTICAL_MARGIN_MM}mm`, bottom: `${VERTICAL_MARGIN_MM}mm`,
    left: `${SIDE_MARGIN_MM}mm`, right: `${SIDE_MARGIN_MM}mm`,
  };
}

const MM_TO_PX = 96 / 25.4;

// Printable box in CSS px, less the vertical breathing room .mermaid-slot adds.
function printableBox(opts) {
  const paper = PAGE_SIZES[opts.format];
  const [width, height] = opts.landscape
    ? [paper.height, paper.width]
    : [paper.width, paper.height];
  return {
    width: Math.round(width - 2 * SIDE_MARGIN_MM * MM_TO_PX),
    height: Math.round(height - 2 * VERTICAL_MARGIN_MM * MM_TO_PX) - 30,
  };
}

function runningHead(title, note) {
  const right = note ? `<span>${escapeHtml(note)}</span>` : '';
  return `<div style="width:100%;font:8pt Helvetica,Arial,sans-serif;color:#8a94a3;
    padding:0 16mm;display:flex;justify-content:space-between;">
    <span>${escapeHtml(title)}</span>${right}</div>`;
}

async function renderPdf({ html, title, opts }) {
  const { chromium } = require(path.join(SKILL_DIR, 'node_modules', 'playwright-core'));
  // Lay mermaid out at the width the diagrams will occupy in print, so
  // label wrapping measured at render time matches the printed result.
  const box = printableBox(opts);

  const browser = await chromium.launch({ executablePath: resolveChrome() });
  try {
    const page = await browser.newPage({ viewport: { width: box.width, height: box.height } });
    await page.setContent(html, { waitUntil: 'load' });
    const rendered = await page.evaluate(h => window.renderAll(h), box.height);
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: opts.output,
      format: opts.format,
      landscape: opts.landscape,
      printBackground: true,
      margin: chromeMargin(),
      displayHeaderFooter: true,
      headerTemplate: runningHead(title, opts.note),
      footerTemplate: `<div style="width:100%;font:8pt Helvetica,Arial,sans-serif;color:#8a94a3;
        padding:0 16mm;text-align:center;">
        Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
    });
    return rendered;
  } finally {
    await browser.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.input)) throw new Error(`input not found: ${opts.input}`);
  ensureDeps();
  const markdown = fs.readFileSync(opts.input, 'utf8');
  const { html, title, diagramCount } = buildHtml({ markdown, inputPath: opts.input });
  const rendered = await renderPdf({ html, title, opts });
  if (rendered.length !== diagramCount) {
    throw new Error(`expected ${diagramCount} mermaid diagram(s), rendered ${rendered.length}`);
  }
  console.log(`${opts.output}: ${diagramCount} diagram(s), title "${title}"`);

  for (const d of rendered) {
    const size = `${Math.round(d.w)}x${Math.round(d.h)}px`;
    if (d.slices > 1) {
      console.log(`  diagram ${d.index + 1}: ${size}, sliced across ${d.slices} pages at ${Math.round(d.scale * 100)}%`);
    } else if (d.bands > 1) {
      console.log(`  diagram ${d.index + 1}: ${size}, wrapped into ${d.bands} bands at ${Math.round(d.scale * 100)}%`);
    } else if (d.scale < LEGIBLE_SCALE) {
      console.log(
        `  diagram ${d.index + 1}: ${size}, shown at ${Math.round(d.scale * 100)}%; ` +
        `vector, so it zooms, but too small to read on paper`
      );
    }
  }
}

main().catch(err => {
  console.error(`md2pdf: ${err.message}`);
  process.exit(1);
});
