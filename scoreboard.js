// Command-line wrapper around scoreboard-core.js.
// Runs entirely locally: pure-JS JPEG/PNG decoding and tesseract.js (WebAssembly OCR)
// with bundled English data. No network.
//
// Usage:  node scoreboard.js <photo.jpg|png> [--debug]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { createWorker, PSM } from "tesseract.js";
import { readScoreboardPixels, clockToSeconds } from "./scoreboard-core.js";

export { clockToSeconds };

const here = path.dirname(fileURLToPath(import.meta.url));
const LANG_PATH = path.join(here, "node_modules/@tesseract.js-data/eng/4.0.0_best_int");

export function decodeImage(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  return jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
}

export async function readScoreboard(imageBuffer, { debug = false } = {}) {
  const worker = await createWorker("eng", 1, { langPath: LANG_PATH, gzip: true, cacheMethod: "none" });
  const ocr = async (crop, { mode, whitelist }) => {
    await worker.setParameters({
      tessedit_pageseg_mode: mode === "word" ? PSM.SINGLE_WORD : PSM.SINGLE_LINE,
      tessedit_char_whitelist: whitelist,
    });
    const png = new PNG({ width: crop.width, height: crop.height });
    png.data = Buffer.from(crop.data.buffer);
    const { data } = await worker.recognize(PNG.sync.write(png));
    return { text: data.text, confidence: data.confidence };
  };
  try {
    return await readScoreboardPixels(decodeImage(imageBuffer), ocr, { log: debug ? console.error : null });
  } finally {
    await worker.terminate();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scoreboard.js <photo> [--debug]");
    process.exit(1);
  }
  const result = await readScoreboard(fs.readFileSync(file), { debug: process.argv.includes("--debug") });
  console.log(JSON.stringify(result, null, 2));
}
