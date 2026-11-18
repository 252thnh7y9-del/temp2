// Copies the shared core and the tesseract.js browser files next to web/index.html,
// so the page can run with no network access.  Run: npm run build:web
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "web");
const nm = path.join(root, "node_modules");
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(web, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(web, to));
};

copy("scoreboard-core.js", "scoreboard-core.js");
copy("node_modules/tesseract.js/dist/tesseract.min.js", "vendor/tesseract.min.js");
copy("node_modules/tesseract.js/dist/worker.min.js", "vendor/worker.min.js");
for (const f of fs.readdirSync(path.join(nm, "tesseract.js-core")).filter((f) => f.endsWith("-lstm.wasm.js"))) {
  copy(`node_modules/tesseract.js-core/${f}`, `vendor/core/${f}`);
}
// Gzipped English model. Named .wasm only so static hosts that whitelist binary
// types will serve it; the page fetches the bytes and hands them to tesseract.
copy("node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "vendor/eng-traineddata-gz.wasm");
console.log("web/ is ready");
