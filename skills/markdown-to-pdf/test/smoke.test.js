// Smoke tests: render fixtures to PDF with the real script and Chromium, then
// inspect the PDF with poppler-utils (pdfinfo, pdftotext, pdfimages). Chromium
// is found the same way md2pdf.js finds it. PDFs are written under
// MD2PDF_TEST_OUT, or the system temp directory, and removed afterwards.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'md2pdf.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const OUT_ROOT = process.env.MD2PDF_TEST_OUT || os.tmpdir();
const RENDER_TIMEOUT_MS = 120000;
// A 1x1 PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64'
);

function tempDir(t) {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(OUT_ROOT, 'md2pdf-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Asynchronous so a test can serve HTTP requests while the renderer runs.
function render(t, input, extraArgs = []) {
  const output = path.join(tempDir(t), path.basename(input).replace(/\.md$/, '.pdf'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, input, output, ...extraArgs]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr, output }));
  });
}

function fixture(name) {
  return path.join(FIXTURES, name);
}

function poppler(tool, args) {
  const result = spawnSync(tool, args, { encoding: 'utf8' });
  if (result.error) throw new Error(`${tool} not runnable (install poppler-utils): ${result.error.message}`);
  assert.equal(result.status, 0, `${tool} failed: ${result.stderr}`);
  return result.stdout;
}

function pageCount(pdf) {
  return Number(poppler('pdfinfo', [pdf]).match(/^Pages:\s+(\d+)/m)[1]);
}

function pdfText(pdf, page) {
  const range = page ? ['-f', String(page), '-l', String(page)] : [];
  return poppler('pdftotext', [...range, pdf, '-']);
}

function imageCount(pdf) {
  // pdfimages -list prints two header lines, then one line per image.
  return poppler('pdfimages', ['-list', pdf]).trim().split('\n').length - 2;
}

test('renders a table, one diagram, the running header and the footer', { timeout: RENDER_TIMEOUT_MS }, async t => {
  const { status, stdout, stderr, output } = await render(t, fixture('sample.md'), ['--note', 'Smoke test']);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /: 1 diagram\(s\), title "Smoke Test Report"/);
  assert.equal(pageCount(output), 1);
  const text = pdfText(output);
  for (const expected of ['Smoke Test Report', 'Smoke test', 'Page 1 of 1', 'Rendered page in headless Chromium',
    'Extract mermaid fences', 'Chromium renders SVG']) {
    assert.ok(text.includes(expected), `PDF text lacks "${expected}"`);
  }
});

test('slices a diagram taller than the page across pages', { timeout: RENDER_TIMEOUT_MS }, async t => {
  const { status, stdout, stderr, output } = await render(t, fixture('tall.md'));
  assert.equal(status, 0, stderr);
  const slices = Number(stdout.match(/diagram 1: \d+x\d+px, sliced across (\d+) pages/)[1]);
  assert.ok(slices > 1);
  assert.ok(pageCount(output) >= slices, `${pageCount(output)} pages for ${slices} slices`);
  const text = pdfText(output);
  assert.match(text, /^Step 0$/m);
  assert.match(text, /^Step 30$/m);
});

test('wraps a diagram far wider than tall into bands', { timeout: RENDER_TIMEOUT_MS }, async t => {
  const { status, stdout, stderr, output } = await render(t, fixture('wide.md'));
  assert.equal(status, 0, stderr);
  const bands = Number(stdout.match(/diagram 1: \d+x\d+px, wrapped into (\d+) bands/)[1]);
  assert.ok(bands > 1);
  const text = pdfText(output);
  assert.match(text, /^Node 0$/m);
  assert.match(text, /^Node 19$/m);
});

test('repeats the table header on continuation pages', { timeout: RENDER_TIMEOUT_MS }, async t => {
  const { status, stderr, output } = await render(t, fixture('long-table.md'));
  assert.equal(status, 0, stderr);
  const pages = pageCount(output);
  assert.ok(pages >= 2, `${pages} page(s)`);
  for (let page = 1; page <= pages; page++) {
    assert.ok(pdfText(output, page).includes('Column header A'), `page ${page} lacks the header`);
  }
  assert.ok(pdfText(output, pages).includes('row 120'));
});

test('recognizes mermaid fences with CRLF, indentation and tildes', { timeout: RENDER_TIMEOUT_MS }, async t => {
  const input = path.join(tempDir(t), 'fences.md');
  fs.writeFileSync(input, [
    '# Fences', '',
    '```mermaid', 'flowchart LR', '  a[Crlf start] --> b[Crlf end]', '```', '',
    '   ```mermaid', '   flowchart LR', '   c[Indented start] --> d[Indented end]', '   ```', '',
    '~~~mermaid', 'flowchart LR', '  e[Tilde start] --> f[Tilde end]', '~~~', '',
  ].join('\r\n'));
  const { status, stdout, stderr, output } = await render(t, input);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /: 3 diagram\(s\)/);
  const text = pdfText(output);
  for (const label of ['Crlf end', 'Indented end', 'Tilde end']) assert.ok(text.includes(label), label);
});

test('runs no script from the document or the diagram sources', { timeout: RENDER_TIMEOUT_MS }, async t => {
  const { status, stderr, output } = await render(t, fixture('inject.md'));
  assert.equal(status, 0, stderr);
  assert.doesNotMatch(pdfText(output), /EXECUTED/);
  assert.match(stderr, /blocked script-src/);
});

test('makes no network request for raw HTML resources', { timeout: RENDER_TIMEOUT_MS }, async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.end('');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const input = path.join(tempDir(t), 'remote.md');
  fs.writeFileSync(input, [
    '# Remote', '',
    `<img src="${origin}/img.png">`, '',
    `<link rel="stylesheet" href="${origin}/style.css">`, '',
    `<iframe src="${origin}/frame.html"></iframe>`, '',
  ].join('\n'));
  const { status, stderr } = await render(t, input);
  assert.equal(status, 0, stderr);
  assert.deepEqual(requests, []);
  assert.match(stderr, /blocked img-src/);
});

test('embeds a local image referenced relative to the Markdown file', { timeout: RENDER_TIMEOUT_MS }, async t => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'figures'));
  fs.writeFileSync(path.join(dir, 'figures', 'my plot.png'), PNG_BYTES);
  const input = path.join(dir, 'doc.md');
  fs.writeFileSync(input, '# Image\n\n![plot](<figures/my plot.png>)\n');
  const { status, stderr, output } = await render(t, input);
  assert.equal(status, 0, stderr);
  assert.equal(imageCount(output), 1);
});

test('fails on a missing or remote image', { timeout: RENDER_TIMEOUT_MS }, async t => {
  const input = path.join(tempDir(t), 'doc.md');
  fs.writeFileSync(input, '# Image\n\n![a](figures/missing.png)\n\n![b](https://example.com/b.png)\n');
  const { status, stderr, output } = await render(t, input);
  assert.equal(status, 1);
  assert.match(stderr, /figures\/missing\.png: image not found/);
  assert.match(stderr, /https:\/\/example\.com\/b\.png: remote images are not fetched/);
  assert.equal(fs.existsSync(output), false);
});

const ARGUMENT_ERRORS = [
  [['--bogus'], /unknown option: --bogus/],
  [['--note', '--landscape'], /--note needs a value/],
  [['--format'], /--format needs a value/],
  [['--format', 'B5'], /--format must be one of: Letter, A4/],
  [['extra.pdf'], /unexpected argument: extra\.pdf/],
];

for (const [args, message] of ARGUMENT_ERRORS) {
  test(`rejects ${args.join(' ')}`, async t => {
    const { status, stderr } = await render(t, fixture('sample.md'), args);
    assert.equal(status, 1);
    assert.match(stderr, message);
  });
}
