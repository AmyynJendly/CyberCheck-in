// Copy the QR decoder (zxing-cpp compiled to WebAssembly) into public/ so the
// scanner loads it from our own domain instead of a CDN. Runs before dev/build.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const src = require.resolve("zxing-wasm/reader/zxing_reader.wasm");
mkdirSync("public/zxing", { recursive: true });
copyFileSync(src, "public/zxing/zxing_reader.wasm");
