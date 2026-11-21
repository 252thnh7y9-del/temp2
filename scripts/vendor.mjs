// Copies the tesseract.js browser files and fonts into vendor/ next to index.html, so the
// page runs with no network access. vendor/ is committed because GitHub Pages
// ("Deploy from a branch") serves the repository as-is.  Run: npm run vendor
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "vendor");
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(out, to));
};

copy("node_modules/tesseract.js/dist/tesseract.min.js", "tesseract.min.js");
copy("node_modules/tesseract.js/dist/worker.min.js", "worker.min.js");
for (const f of fs.readdirSync(path.join(root, "node_modules/tesseract.js-core")).filter((f) => f.endsWith("-lstm.wasm.js"))) {
  copy(`node_modules/tesseract.js-core/${f}`, `core/${f}`);
}
// Gzipped English model. Named .wasm so hosts that only serve known binary types will serve it;
// ocr-worker.js points tesseract's request for eng.traineddata.gz at this file.
copy("node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "eng-traineddata-gz.wasm");
// Fonts, served locally so the page looks right offline.
for (const [pkg, file] of [
  ["chakra-petch", "chakra-petch-latin-500-normal.woff2"],
  ["chakra-petch", "chakra-petch-latin-600-normal.woff2"],
  ["chakra-petch", "chakra-petch-latin-700-normal.woff2"],
  ["inter", "inter-latin-400-normal.woff2"],
  ["inter", "inter-latin-500-normal.woff2"],
  ["inter", "inter-latin-600-normal.woff2"],
]) copy(`node_modules/@fontsource/${pkg}/files/${file}`, `fonts/${file}`);
console.log("vendor/ is ready");
