#!/usr/bin/env node
// Upload telemoji animated stickers to R2 (bucket web3-chat-voice, prefix stickers/).
//
// Pipeline per emoji record:
//   download original WebP from GitHub LFS media endpoint
//   -> sharp resize to width 192 keeping animation (webp, quality 80)
//   -> wrangler r2 object put (remote)
//
// Usage (from worker dir):
//   node scripts/upload_stickers.mjs [--input <path>] [--limit N] [--concurrency N] [--index-only]
//
// Resume: completed keys are recorded in scripts/.upload_stickers_state.json and skipped
// on subsequent runs; failures are retried up to 3 times per run and listed at the end.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.resolve(WORKER_DIR, '../../.perf/telemoji/telemoji_emojis.json');
const STATE_FILE = path.join(__dirname, '.upload_stickers_state.json');
const BUCKET = 'web3-chat-voice';
const MEDIA_BASE = 'https://media.githubusercontent.com/media/saeedtahmtan/telemoji/main/';
const MAX_RETRIES = 3;

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, limit: Infinity, concurrency: 7, indexOnly: false };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--input': args.input = path.resolve(argv[++i]); break;
      case '--limit': args.limit = parseInt(argv[++i], 10); break;
      case '--concurrency': args.concurrency = Math.min(8, Math.max(1, parseInt(argv[++i], 10))); break;
      case '--index-only': args.indexOnly = true; break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  return args;
}

function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      return { done: new Set(s.done ?? []), failed: s.failed ?? {} };
    } catch { /* fall through to fresh state */ }
  }
  return { done: new Set(), failed: {} };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify({ done: [...state.done], failed: state.failed }, null, 1));
}

// sticker key body: "webp/animated/U+2764_1.webp" -> "animated/U+2764_1"
function keyBodyOf(record) {
  return record.file_webp.replace(/^webp\//, '').replace(/\.webp$/, '');
}

function buildIndex(records) {
  // Category is derived from the actual storage path: 11 records typed "status"
  // are stored under "default_status/", and k must always match the R2 key body.
  const categories = [...new Set(records.map((r) => keyBodyOf(r).split('/')[0]))];
  const items = records.map((r) => {
    const item = { k: keyBodyOf(r), e: r.emoji };
    if (r.type === 'flags') {
      item.n = r.name || r.code || '';
    }
    return item;
  });
  return { version: 1, categories, items };
}

async function downloadToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

// Keep stickers comfortably under the 300KB serving budget.
const TARGET_MAX_BYTES = 290 * 1024;
// WebP canvas height limit is 16383px, so a 192px-tall frame stack holds at most 85 frames.
const MAX_STACK_FRAMES = 85;

function encodeSubsampled(raw, pages, frameWidth, frameHeight, baseDelay, step, quality) {
  const kept = [];
  for (let i = 0; i < pages; i += step) kept.push(i);
  if (kept.length < 2 && pages >= 2) kept.push(pages - 1);
  const frameBytes = frameWidth * frameHeight * 4;
  const out = Buffer.alloc(frameBytes * kept.length);
  kept.forEach((p, j) => raw.copy(out, j * frameBytes, p * frameBytes, (p + 1) * frameBytes));
  return sharp(out, {
    raw: { width: frameWidth, height: frameHeight * kept.length, channels: 4, pageHeight: frameHeight },
  })
    .webp({ quality, animated: true, delay: kept.map(() => Math.min(65535, baseDelay * step)), effort: 4 })
    .toBuffer();
}

async function shrinkTo192Animated(src, dest) {
  const first = await sharp(src, { animated: true })
    .resize({ width: 192, withoutEnlargement: true })
    .webp({ quality: 80, animated: true })
    .toBuffer();
  if (first.length <= TARGET_MAX_BYTES) {
    writeFileSync(dest, first);
    return { bytes: first.length, subsampled: false };
  }

  // Long animations exceed the budget at full frame rate; drop frames
  // (keeping overall duration via scaled delays) until it fits.
  const meta = await sharp(src, { animated: true }).metadata();
  const pages = meta.pages ?? 1;
  const srcWidth = meta.width ?? 192;
  const frameWidth = Math.min(192, srcWidth);
  const frameHeight = Math.max(1, Math.round(((meta.height ?? pages) / pages) * (frameWidth / srcWidth)));
  const baseDelay = meta.delay?.[0] ?? 40;
  const { data } = await sharp(src, { animated: true })
    .resize({ width: frameWidth, withoutEnlargement: true })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const minStep = Math.max(2, Math.ceil(pages / MAX_STACK_FRAMES));
  let best = null;
  for (const step of [minStep, minStep + 1, minStep + 2, minStep + 4]) {
    for (const quality of [70, 50]) {
      const buf = await encodeSubsampled(data, pages, frameWidth, frameHeight, baseDelay, step, quality);
      if (!best || buf.length < best.length) best = buf;
      if (buf.length <= TARGET_MAX_BYTES) {
        writeFileSync(dest, buf);
        return { bytes: buf.length, subsampled: true };
      }
    }
  }
  writeFileSync(dest, best);
  return { bytes: best.length, subsampled: true };
}

function wranglerPut(objectKey, file, contentType) {
  return new Promise((resolve, reject) => {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(
      npx,
      ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${objectKey}`, '--file', file, '--content-type', contentType, '--remote'],
      { cwd: WORKER_DIR, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }
    );
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler put exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

async function processOne(record, tag) {
  const keyBody = keyBodyOf(record);
  const objectKey = `stickers/${keyBody}.webp`;
  const srcFile = path.join(tmpdir(), `sticker-src-${tag}.webp`);
  const outFile = path.join(tmpdir(), `sticker-out-${tag}.webp`);
  try {
    await downloadToFile(MEDIA_BASE + record.file_webp, srcFile);
    const srcSize = statSync(srcFile).size;
    if (srcSize < 1024) {
      throw new Error(`suspicious download size ${srcSize} bytes for ${record.file_webp}`);
    }
    await shrinkTo192Animated(srcFile, outFile);
    await wranglerPut(objectKey, outFile, 'image/webp');
  } finally {
    await unlink(srcFile).catch(() => {});
    await unlink(outFile).catch(() => {});
  }
}

async function uploadIndex(records) {
  const index = buildIndex(records);
  const indexFile = path.join(tmpdir(), `stickers-index-${process.pid}.json`);
  writeFileSync(indexFile, JSON.stringify(index));
  try {
    await wranglerPut('stickers/index.json', indexFile, 'application/json');
  } finally {
    await unlink(indexFile).catch(() => {});
  }
  return index;
}

async function main() {
  const args = parseArgs(process.argv);
  const records = JSON.parse(readFileSync(args.input, 'utf8'));
  console.log(`loaded ${records.length} records from ${args.input}`);

  if (args.indexOnly) {
    const index = await uploadIndex(records);
    console.log(`uploaded stickers/index.json: ${index.items.length} items, categories: ${index.categories.join(', ')}`);
    return;
  }

  const state = loadState();
  const pending = records.filter((r) => !state.done.has(keyBodyOf(r))).slice(0, args.limit);
  console.log(`pending: ${pending.length} (already done: ${state.done.size}, concurrency: ${args.concurrency}, retries: ${MAX_RETRIES})`);

  let succeeded = 0;
  let failedThisRun = 0;
  let cursor = 0;

  async function worker(tag) {
    while (cursor < pending.length) {
      const record = pending[cursor++];
      const keyBody = keyBodyOf(record);
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await processOne(record, `${process.pid}-${tag}-${attempt}`);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`[retry ${attempt}/${MAX_RETRIES}] ${keyBody}: ${err.message}`);
        }
      }
      if (lastErr) {
        failedThisRun++;
        state.failed[keyBody] = lastErr.message;
      } else {
        succeeded++;
        state.done.add(keyBody);
        delete state.failed[keyBody];
      }
      const processed = succeeded + failedThisRun;
      if (processed % 25 === 0 || processed === pending.length) {
        console.log(`progress: ${processed}/${pending.length} (ok=${succeeded}, failed=${failedThisRun})`);
        saveState(state);
      }
    }
  }

  await Promise.all(Array.from({ length: args.concurrency }, (_, i) => worker(i)));
  saveState(state);

  console.log(`\nupload stats: succeeded=${succeeded}, failed=${failedThisRun}, total done=${state.done.size}/${records.length}`);
  const failedKeys = Object.keys(state.failed);
  if (failedKeys.length > 0) {
    console.log(`failed keys (${failedKeys.length}):`);
    for (const k of failedKeys) console.log(`  ${k}: ${state.failed[k]}`);
  } else {
    const index = await uploadIndex(records);
    console.log(`uploaded stickers/index.json: ${index.items.length} items, categories: ${index.categories.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
