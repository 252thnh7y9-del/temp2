// Read the score and game clock from a photo of an LED scoreboard.
// Runs entirely locally: pure-JS JPEG/PNG decoding, pure-JS image processing,
// and tesseract.js (WebAssembly OCR) with bundled English data. No network.
//
// Usage:  node scoreboard.js <photo.jpg|png> [--debug]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { createWorker, PSM } from "tesseract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LANG_PATH = path.join(here, "node_modules/@tesseract.js-data/eng/4.0.0_best_int");

// ---------- image loading ----------

export function decodeImage(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  return jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
}

// ---------- masks ----------

// Lit LED text: bright and clearly blue/white rather than warm.
// Screen background: dark, slightly blue.
function buildMasks({ width: W, height: H, data: D }) {
  const text = new Uint8Array(W * H);
  const dark = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = D[i * 4], g = D[i * 4 + 1], b = D[i * 4 + 2];
    if (b >= 170 && b - r >= 50 && g >= 110) text[i] = 1;
    else if (Math.max(r, g, b) < 110 && b >= r + 5) dark[i] = 1;
  }
  return { text, dark };
}

// ---------- connected components (4-connected, iterative) ----------

function components(mask, W, H, minArea = 1) {
  const label = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  const out = [];
  let next = 1;
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || label[start]) continue;
    let sp = 0, area = 0;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    stack[sp++] = start;
    label[start] = next;
    while (sp) {
      const p = stack[--sp];
      const x = p % W, y = (p / W) | 0;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - W] && !label[p - W]) { label[p - W] = next; stack[sp++] = p - W; }
      if (y < H - 1 && mask[p + W] && !label[p + W]) { label[p + W] = next; stack[sp++] = p + W; }
    }
    if (area >= minArea) out.push({ id: next, area, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    next++;
  }
  return { label, comps: out };
}

// ---------- grouping blobs into words ----------

function groupIntoWords(comps) {
  const sorted = [...comps].sort((a, b) => a.x0 - b.x0);
  const words = [];
  for (const c of sorted) {
    let best = null;
    for (const w of words) {
      const overlap = Math.min(w.y1, c.y1) - Math.max(w.y0, c.y0);
      const minH = Math.min(w.h, c.h);
      const maxH = Math.max(w.h, c.h);
      const gap = c.x0 - w.x1;
      // same line: vertically overlapping, close horizontally.
      // Small blobs (colon dots) may join a word but don't define its height.
      const sizeOk = c.h >= 0.5 * w.h || c.h <= 0.35 * w.h;
      if (overlap > 0.5 * minH && gap < 1.2 * maxH && gap > -0.5 * maxH && sizeOk) {
        best = w; break;
      }
    }
    if (best) {
      best.parts.push(c);
      best.x0 = Math.min(best.x0, c.x0); best.x1 = Math.max(best.x1, c.x1);
      best.y0 = Math.min(best.y0, c.y0); best.y1 = Math.max(best.y1, c.y1);
      best.w = best.x1 - best.x0 + 1; best.h = best.y1 - best.y0 + 1;
    } else {
      words.push({ parts: [c], x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, w: c.w, h: c.h });
    }
  }
  return words;
}

// ---------- crop a word as a clean black-on-white PNG for OCR ----------
// Upscales from the original pixels (bilinear on a "how text-like" channel)
// and thresholds per word with Otsu, so small labels stay legible.

function textness(D, i) {
  const r = D[i], g = D[i + 1], b = D[i + 2];
  return Math.max(0, Math.min(255, (b - r) * 1.5 + (g - 90)));
}

function cropWord(word, img, targetH = 64, pad = 24) {
  const { width: W, height: H, data: D } = img;
  const m = Math.max(1, Math.round(word.h * 0.08));
  const bx0 = Math.max(0, word.x0 - m), by0 = Math.max(0, word.y0 - m);
  const bx1 = Math.min(W - 1, word.x1 + m), by1 = Math.min(H - 1, word.y1 + m);
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const scale = targetH / bh;
  const iw = Math.max(1, Math.round(bw * scale));

  const src = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) src[y * bw + x] = textness(D, ((by0 + y) * W + bx0 + x) * 4);

  const up = new Float32Array(iw * targetH);
  for (let oy = 0; oy < targetH; oy++) {
    const fy = Math.min(bh - 1, Math.max(0, (oy + 0.5) / scale - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let ox = 0; ox < iw; ox++) {
      const fx = Math.min(bw - 1, Math.max(0, (ox + 0.5) / scale - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      up[oy * iw + ox] =
        (src[y0 * bw + x0] * (1 - tx) + src[y0 * bw + x1] * tx) * (1 - ty) +
        (src[y1 * bw + x0] * (1 - tx) + src[y1 * bw + x1] * tx) * ty;
    }
  }

  const t = otsu(up);
  const ow = iw + pad * 2, oh = targetH + pad * 2;
  const png = new PNG({ width: ow, height: oh });
  png.data.fill(255);
  for (let y = 0; y < targetH; y++)
    for (let x = 0; x < iw; x++)
      if (up[y * iw + x] > t) {
        const o = ((y + pad) * ow + x + pad) * 4;
        png.data[o] = png.data[o + 1] = png.data[o + 2] = 0;
      }
  return PNG.sync.write(png);
}

function otsu(values) {
  const hist = new Float64Array(256);
  for (const v of values) hist[Math.max(0, Math.min(255, v | 0))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thresh = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thresh = i; }
  }
  return thresh;
}

// ---------- main extraction ----------

export async function readScoreboard(imageBuffer, { debug = false } = {}) {
  const img = decodeImage(imageBuffer);
  const { width: W, height: H } = img;
  const { text, dark } = buildMasks(img);

  // 1. The screen is the largest dark region.
  const { comps: darkComps } = components(dark, W, H, 1000);
  if (!darkComps.length) throw new Error("Could not find the scoreboard screen");
  const screen = darkComps.reduce((a, b) => (b.area > a.area ? b : a));

  // 2. Text blobs fully inside the screen.
  const minDim = Math.min(screen.w, screen.h);
  const { label, comps } = components(text, W, H, Math.max(20, (minDim / 200) ** 2));
  const inside = comps.filter(
    (c) => c.x0 > screen.x0 && c.x1 < screen.x1 && c.y0 > screen.y0 && c.y1 < screen.y1 &&
           c.h < screen.h * 0.4 && c.w < screen.w * 0.4,
  );

  // 3. Words, ignoring tiny specks that didn't attach to anything.
  const words = groupIntoWords(inside).filter((w) => w.h >= minDim * 0.02);

  // 4. OCR each word twice: once as letters, once as digits/clock.
  const worker = await createWorker("eng", 1, { langPath: LANG_PATH, gzip: true, cacheMethod: "none" });
  try {
    for (const w of words) {
      const png = cropWord(w, img);
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: "0123456789:." });
      const d = await worker.recognize(png);
      w.digits = d.data.text.replace(/\s+/g, "");
      w.digitConf = d.data.confidence;
      await worker.setParameters({ tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ " });
      const t = await worker.recognize(png);
      w.letters = t.data.text.trim().replace(/\s+/g, " ");
      w.letterConf = t.data.confidence;
      w.cx = (w.x0 + w.x1) / 2;
      w.cy = (w.y0 + w.y1) / 2;
    }
  } finally {
    await worker.terminate();
  }
  if (debug) {
    for (const w of words) {
      console.error(`[${w.x0},${w.y0} ${w.w}x${w.h}] digits=${JSON.stringify(w.digits)}(${w.digitConf}) letters=${JSON.stringify(w.letters)}(${w.letterConf})`);
    }
  }

  return interpret(words, screen);
}

// ---------- turn OCR'd words into a game state using the layout ----------

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Does any word of the label look like one of the keywords (OCR-tolerant)?
function looksLike(label, keywords) {
  return label.split(" ").some((part) =>
    keywords.some((k) => part.length >= 3 && editDistance(part, k) <= Math.max(1, Math.floor(k.length / 3))));
}

function interpret(words, screen) {
  const midX = (screen.x0 + screen.x1) / 2;
  const isNumber = (w) => /^\d{1,3}$/.test(w.digits) && w.digitConf >= 60;

  // Clock: "M:SS" / "MM:SS", or tenths "S.T"; biggest such word wins.
  const clockWord = words
    .filter((w) => /^\d{1,2}:\d{2}$/.test(w.digits) || /^\d{1,2}\.\d$/.test(w.digits))
    .sort((a, b) => b.h - a.h)[0] ?? null;

  const numbers = words.filter((w) => w !== clockWord && isNumber(w));
  const labels = words.filter((w) => w !== clockWord && !numbers.includes(w) &&
    /^[A-Z][A-Z ]{2,}$/.test(w.letters) && w.letterConf >= 40);

  const used = new Set();
  const take = (n) => { if (n) used.add(n); return n ?? null; };
  const free = () => numbers.filter((n) => !used.has(n));

  // Scores: the two biggest numbers, one each side of centre.
  const bySize = [...numbers].sort((a, b) => b.h - a.h);
  const homeW = take(bySize.find((n) => n.cx < midX));
  const awayW = take(bySize.find((n) => n.cx > midX));

  const sameColumn = (a, b) => Math.abs(a.cx - b.cx) < Math.max(a.w, b.w) * 0.75;
  const closestBelow = (ref, pool) =>
    pool.filter((n) => n.cy > ref.cy && sameColumn(n, ref)).sort((a, b) => a.cy - b.cy)[0] ?? null;

  const periodLabels = labels.filter((l) => looksLike(l.letters, ["PERIOD", "QTR", "QUARTER", "HALF", "INNING"]));
  const foulLabels = labels.filter((l) => looksLike(l.letters, ["FOULS", "FOUL"]));

  // Period: number under a PERIOD label, else the number nearest the centre line.
  let periodW = null;
  for (const l of periodLabels) periodW ??= closestBelow(l, free());
  periodW ??= free()
    .filter((n) => Math.abs(n.cx - midX) < screen.w * 0.1)
    .sort((a, b) => Math.abs(a.cx - midX) - Math.abs(b.cx - midX))[0] ?? null;
  take(periodW);

  // Fouls: number under a FOULS label on that side, else the number under the score.
  const foulsFor = (score) => {
    if (!score) return null;
    const side = (w) => (w.cx < midX) === (score.cx < midX);
    let n = null;
    for (const l of foulLabels.filter(side)) n ??= closestBelow(l, free());
    n ??= closestBelow(score, free());
    return take(n) ? Number(n.digits) : null;
  };

  // Team name: closest label above each score that isn't a known caption.
  const captions = new Set([...periodLabels, ...foulLabels]);
  const nameAbove = (score) => {
    if (!score) return null;
    return labels
      .filter((l) => !captions.has(l) && l.cy < score.cy && Math.abs(l.cx - score.cx) < Math.max(l.w, score.w))
      .sort((a, b) => b.cy - a.cy)[0]?.letters ?? null;
  };

  const clock = clockWord?.digits ?? null;
  return {
    home: { name: nameAbove(homeW), score: homeW ? Number(homeW.digits) : null, fouls: foulsFor(homeW) },
    away: { name: nameAbove(awayW), score: awayW ? Number(awayW.digits) : null, fouls: foulsFor(awayW) },
    clock,
    seconds: clockToSeconds(clock),
    period: periodW ? Number(periodW.digits) : null,
  };
}

// "2:34" -> 154, "0:45.3" -> 45.3, "45.3" -> 45.3. Returns null if unreadable.
export function clockToSeconds(clock) {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(clock ?? "");
  if (!m) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2]);
}

// ---------- CLI ----------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scoreboard.js <photo> [--debug]");
    process.exit(1);
  }
  const result = await readScoreboard(fs.readFileSync(file), { debug: process.argv.includes("--debug") });
  console.log(JSON.stringify(result, null, 2));
}
