// Smoke test: render the fixtures to PDF with the real script and Chromium.
// Chromium is found the same way md2pdf.js finds it (CHROME_PATH, the
// Playwright cache, then system paths).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'md2pdf.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const RENDER_TIMEOUT_MS = 120000;

function render(fixtureName, extraArgs = []) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2pdf-test-'));
  const output = path.join(outDir, fixtureName.replace(/\.md$/, '.pdf'));
  const result = spawnSync(
    process.execPath,
    [SCRIPT, path.join(FIXTURES, fixtureName), output, ...extraArgs],
    { encoding: 'utf8', timeout: RENDER_TIMEOUT_MS }
  );
  return { result, output, outDir };
}

test('renders a table and one mermaid diagram to a PDF', { timeout: RENDER_TIMEOUT_MS }, t => {
  const { result, output, outDir } = render('sample.md', ['--note', 'Smoke test']);
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(output).subarray(0, 4).toString('latin1'), '%PDF');
  assert.match(result.stdout, /: 1 diagram\(s\), title "Smoke Test Report"/);
});

test('slices a diagram taller than the page across pages', { timeout: RENDER_TIMEOUT_MS }, t => {
  const { result, output, outDir } = render('tall.md');
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.statSync(output).size > 0);
  assert.match(result.stdout, /diagram 1: \d+x\d+px, sliced across \d+ pages/);
});

test('rejects an unknown option', () => {
  const { result, outDir } = render('sample.md', ['--bogus']);
  fs.rmSync(outDir, { recursive: true, force: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option: --bogus/);
});
