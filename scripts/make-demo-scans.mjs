/**
 * Synthetic scanner output for manually testing Scan Stitch. Never uses real documents.
 *
 * Generate a fake scanner tree (one PDF per page, numbering restarts per day folder,
 * like a Canon scanner):
 *
 *   node scripts/make-demo-scans.mjs <outDir> [--days a,b,...] [--count N]
 *
 *   Default days are 2026_10_13 (IMG_0001..0006) and 2026_10_14 (IMG_0001..0004).
 *   --days    comma separated day folder names (4 pages each after the first two,
 *             which keep 6 and 4 pages)
 *   --count N write ONE day folder (the first of --days) with N pages, for stack
 *             performance tests (e.g. --count 80)
 *
 *   Three pages are deliberately the wrong way round, in every generated day list:
 *   day 1 page 2 (/Rotate 90), day 1 page 5 (upside down, /Rotate 180) and
 *   day 2 page 3 (/Rotate 90). With --count, pages 2, 5 and 9 are wrong-way.
 *
 * Simulate pages arriving during a session (copies one file at a time, newest
 * modification time, via a temporary name so the watcher only sees complete files):
 *
 *   node scripts/make-demo-scans.mjs --drip <srcDir> <destDir> <seconds> [--limit N]
 *
 *   Stage first, e.g. generate into <demo>/scanner-staged with --days 2026_10_15,2026_10_16,
 *   then drip from there into the watched folder. Existing destination files are skipped.
 *
 * The recommended demo setup:
 *   node scripts/make-demo-scans.mjs C:\Dev\scan-stitch-demo\scanner
 *   node scripts/make-demo-scans.mjs C:\Dev\scan-stitch-demo\scanner-staged --days 2026_10_15,2026_10_16
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

const A4 = [595.28, 841.89];

const HEADLINES = [
  ['Quarterly report', 'Q3 results at a glance'],
  ['Invoice 4821', 'Acme Fixtures Ltd'],
  ['Meeting notes', 'Product sync, Tuesday'],
  ['Receipt', 'Corner Cafe, table 7'],
  ['Contract', 'Service agreement draft'],
  ['Delivery note', 'Parcel 77-2210'],
  ['Timesheet', 'Week 41'],
  ['Floor plan', 'Second floor, east wing'],
  ['Price list', 'Spring catalogue'],
  ['Warranty card', 'Model KX-200'],
  ['Travel itinerary', 'Lisbon, three nights'],
  ['Expense claim', 'Conference travel'],
];

const LOREM = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit,',
  'sed do eiusmod tempor incididunt ut labore et dolore',
  'magna aliqua. Ut enim ad minim veniam, quis nostrud',
  'exercitation ullamco laboris nisi ut aliquip ex ea',
  'commodo consequat. Duis aute irure dolor in reprehenderit.',
];

/** Rotation by (zero-based day index, one-based page number). */
function rotationFor(dayIndex, page, countMode) {
  if (countMode) return { 2: 90, 5: 180, 9: 90 }[page] ?? 0;
  if (dayIndex === 0 && page === 2) return 90;
  if (dayIndex === 0 && page === 5) return 180;
  if (dayIndex === 1 && page === 3) return 90;
  return 0;
}

async function makePage(dayName, page, seq, rotation) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Demo scan ${dayName} IMG_${String(page).padStart(4, '0')}`);
  doc.setProducer('scan-stitch demo generator');
  const p = doc.addPage(A4);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [w, h] = A4;
  const [headline, sub] = HEADLINES[seq % HEADLINES.length];
  const ink = rgb(0.1, 0.1, 0.15);
  const grey = rgb(0.45, 0.45, 0.5);

  p.drawRectangle({ x: 24, y: 24, width: w - 48, height: h - 48, borderColor: grey, borderWidth: 1 });
  p.drawText('TOP OF PAGE', { x: 40, y: h - 44, size: 10, font: bold, color: grey });
  p.drawText(`${dayName}  IMG_${String(page).padStart(4, '0')}.pdf`, { x: 40, y: h - 58, size: 9, font, color: grey });

  // Big page number in the top-right corner.
  const num = String(page);
  const numSize = 110;
  const numW = bold.widthOfTextAtSize(num, numSize);
  p.drawText(num, { x: w - 40 - numW, y: h - 40 - numSize * 0.75, size: numSize, font: bold, color: rgb(0.78, 0.82, 0.92) });

  p.drawText(headline, { x: 48, y: h - 190, size: 38, font: bold, color: ink });
  p.drawText(sub, { x: 48, y: h - 218, size: 16, font, color: grey });
  if (seq >= HEADLINES.length) p.drawText(`(filler page ${seq + 1})`, { x: 48, y: h - 238, size: 12, font, color: grey });

  let y = h - 270;
  for (let i = 0; i < 12; i++) {
    p.drawText(LOREM[(i + seq) % LOREM.length], { x: 48, y, size: 12, font, color: ink });
    y -= 18;
  }

  // Ruled table: 3 columns x 5 rows.
  const tx = 48;
  const tw = w - 96;
  const rowH = 30;
  const top = y - 14;
  const rows = 5;
  p.drawRectangle({ x: tx, y: top - rows * rowH, width: tw, height: rows * rowH, borderColor: ink, borderWidth: 1 });
  for (let r = 1; r < rows; r++) {
    p.drawLine({ start: { x: tx, y: top - r * rowH }, end: { x: tx + tw, y: top - r * rowH }, thickness: 0.7, color: grey });
  }
  for (const f of [0.5, 0.78]) {
    p.drawLine({ start: { x: tx + tw * f, y: top }, end: { x: tx + tw * f, y: top - rows * rowH }, thickness: 0.7, color: grey });
  }
  const cols = ['Item', 'Qty', 'Amount'];
  const colX = [tx + 8, tx + tw * 0.5 + 8, tx + tw * 0.78 + 8];
  cols.forEach((c, i) => p.drawText(c, { x: colX[i], y: top - 20, size: 11, font: bold, color: ink }));
  for (let r = 1; r < rows; r++) {
    p.drawText(`Line ${r}`, { x: colX[0], y: top - r * rowH - 20, size: 11, font, color: ink });
    p.drawText(String(r + page), { x: colX[1], y: top - r * rowH - 20, size: 11, font, color: ink });
    p.drawText(`${(r * 12.5 + page).toFixed(2)}`, { x: colX[2], y: top - r * rowH - 20, size: 11, font, color: ink });
  }

  p.drawText(`page ${page} of this day`, { x: 48, y: 44, size: 10, font, color: grey });
  if (rotation !== 0) p.setRotation(degrees(rotation));
  return doc.save();
}

function parseGenerate(argv) {
  const out = { outDir: null, days: ['2026_10_13', '2026_10_14'], count: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') out.days = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--count') out.count = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else if (out.outDir === null) out.outDir = a;
    else throw new Error(`Unexpected argument ${a}`);
  }
  if (!out.outDir) throw new Error('Missing <outDir>');
  if (out.days.length === 0) throw new Error('--days needs at least one name');
  for (const d of out.days) {
    if (!/^[A-Za-z0-9_-]+$/.test(d)) throw new Error(`Invalid day folder name "${d}" (letters, digits, _ and - only)`);
  }
  if (out.count !== null && (!Number.isInteger(out.count) || out.count < 1)) throw new Error('--count needs a positive integer');
  return out;
}

/** Refuses a directory that holds anything but demo day folders of IMG_####.pdf files. */
function assertDemoDir(root) {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const ok =
      /^[A-Za-z0-9_-]+$/.test(name) &&
      statSync(dir).isDirectory() &&
      readdirSync(dir).every((f) => /^IMG_\d{4,}\.pdf$/.test(f));
    if (!ok) throw new Error(`Refusing to write into ${root}: it contains "${name}", which is not a demo day folder`);
  }
}

async function generate(argv) {
  const { outDir, days, count } = parseGenerate(argv);
  const root = resolve(outDir);
  assertDemoDir(root);
  const plan = count !== null ? [[days[0], count]] : days.map((d, i) => [d, [6, 4][i] ?? 4]);
  let seq = 0;
  let total = 0;
  for (const [di, [day, n]] of plan.entries()) {
    const dir = join(root, day);
    mkdirSync(dir, { recursive: true });
    for (let page = 1; page <= n; page++) {
      const bytes = await makePage(day, page, seq++, rotationFor(di, page, count !== null));
      const file = join(dir, `IMG_${String(page).padStart(4, '0')}.pdf`);
      try {
        writeFileSync(file, bytes, { flag: 'wx' });
        total++;
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e;
        console.log(`skip (exists) ${file}`);
      }
    }
    console.log(`${dir}: ${n} pages`);
  }
  console.log(`Wrote ${total} synthetic pages under ${root}`);
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drip(argv) {
  const args = [];
  let limit = Infinity;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') limit = Number(argv[++i]);
    else args.push(argv[i]);
  }
  const [src, dest, secs] = args;
  const seconds = Number(secs);
  if (!src || !dest || !Number.isFinite(seconds) || seconds < 0 || (!Number.isFinite(limit) && limit !== Infinity)) {
    throw new Error('Usage: --drip <srcDir> <destDir> <seconds> [--limit N]');
  }
  const srcRoot = resolve(src);
  const destRoot = resolve(dest);
  const files = listFiles(srcRoot).filter((f) => f.toLowerCase().endsWith('.pdf'));
  let copied = 0;
  for (const rel of files) {
    if (copied >= limit) break;
    const target = join(destRoot, rel);
    if (existsSync(target)) {
      console.log(`skip (exists) ${rel}`);
      continue;
    }
    if (copied > 0) await sleep(seconds * 1000);
    mkdirSync(join(target, '..'), { recursive: true });
    // A fresh write gives the file a new birth/modification time, which satisfies the watcher's
    // "newer than session start" rule. It goes under a name the *.pdf pattern ignores, then is renamed.
    const tmp = `${target}.part`;
    writeFileSync(tmp, readFileSync(join(srcRoot, rel)), { flag: 'wx' });
    renameSync(tmp, target);
    copied++;
    console.log(`${new Date().toLocaleTimeString()}  dropped ${rel}`);
  }
  console.log(`Dripped ${copied} file(s) into ${destRoot}`);
}

const argv = process.argv.slice(2);
try {
  if (argv[0] === '--drip') await drip(argv.slice(1));
  else await generate(argv);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  console.error('See the header of scripts/make-demo-scans.mjs for usage.');
  process.exit(1);
}
