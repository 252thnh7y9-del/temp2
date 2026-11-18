// Thin wrapper around tesseract.js's worker. Some static hosts won't serve .gz
// files, so the English model is published as vendor/eng-traineddata-gz.wasm;
// this points tesseract's request for eng.traineddata.gz at that file.
const realFetch = self.fetch.bind(self);
self.fetch = (url, opts) =>
  realFetch(String(url).replace(/\/eng\.traineddata\.gz$/, "/eng-traineddata-gz.wasm"), opts);
importScripts("vendor/worker.min.js");
