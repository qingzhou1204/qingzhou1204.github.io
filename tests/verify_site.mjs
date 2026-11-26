#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, "..");

function makeDomStub() {
  const elems = new Map();
  const makeEl = (id) => ({
    id, value: "", textContent: "", innerHTML: "", href: "", download: "", className: "",
    dataset: {}, options: [], files: [],
    style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, click() {}, appendChild() {}, remove() {},
    querySelector() { return makeEl("q"); },
    querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return ""; },
  });
  return {
    getElementById(id) {
      if (!elems.has(id)) elems.set(id, makeEl(id));
      return elems.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(tag) { return makeEl(tag); },
    activeElement: { tagName: "BODY" },
  };
}

function runHtmlInVm(relHtmlPath) {
  const fullPath = path.join(siteRoot, relHtmlPath);
  assert.ok(fs.existsSync(fullPath), `Missing file: ${relHtmlPath}`);
  const html = fs.readFileSync(fullPath, "utf-8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1, `No inline script found in ${relHtmlPath}`);

  const doc = makeDomStub();
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
    TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, Map, Set,
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
    document: doc,
    window: { open() {}, print() {}, QZ_CHECKOUT: {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    alert() {},
  });
  ctx.window.document = doc;
  for (let i = 0; i < scripts.length; i++) {
    new vm.Script(scripts[i][1], { filename: `${relHtmlPath}#${i}` }).runInContext(ctx);
  }
  return { ctx, html };
}

// 1. Validate checkout-config.js
const cfgCode = fs.readFileSync(path.join(siteRoot, "checkout-config.js"), "utf-8");
const cfgCtx = vm.createContext({ window: {} });
new vm.Script(cfgCode, { filename: "checkout-config.js" }).runInContext(cfgCtx);
assert.ok(cfgCtx.window.QZ_CHECKOUT && cfgCtx.window.QZ_CHECKOUT.pro_price_cny, "QZ_CHECKOUT invalid");

// 2. Validate sitemap & robots
const sitemap = fs.readFileSync(path.join(siteRoot, "sitemap.xml"), "utf-8");
const locs = [...sitemap.matchAll(/<loc>https:\/\/qingzhou1204\.github\.io(\/[^<]*)<\/loc>/g)].map(m => m[1]);
assert.equal(locs.length, 6, "Expected 6 URLs in sitemap.xml");
for (const u of locs) {
  const rel = u === "/" ? "index.html" : path.join(u.slice(1), "index.html");
  assert.ok(fs.existsSync(path.join(siteRoot, rel)), `Sitemap target missing: ${rel}`);
}

// 3. Compile & test all HTML pages
runHtmlInVm("index.html");
runHtmlInVm("tools/quote-generator/index.html");
runHtmlInVm("tools/agent-ui-lab/index.html");

// 4. Functional logic tests: CSV Merger
const { ctx: csvCtx } = runHtmlInVm("tools/csv-invoice-merger/index.html");
const csvRes = csvCtx.processDatasets([
  { name: "a.csv", text: "报销人,部门,类目,金额,发票号\n张三,技术部,服务器,¥500.00,INV-1\n李四,技术部,打车,100," },
  { name: "b.csv", text: "报销人,部门,类目,金额,发票号\n王五,市场部,重复报销,500,INV-1\n赵六,市场部,负值,-20,INV-2" }
]);
assert.equal(csvRes.valid.length, 1);
assert.equal(csvRes.anomalies.length, 3);

// 5. Functional logic tests: E-Commerce SKU profit + native ZIP builder
const { ctx: ecoCtx } = runHtmlInVm("tools/ecommerce-kit/index.html");
const skuRes = ecoCtx.calcSkuProfits([
  "sku,name,qty,revenue,cost,fee,shipping,refund\nS1,灯,10,1000,300,50,50,0\nS2,壶,5,200,150,20,30,80"
]);
assert.equal(skuRes.length, 2);
assert.equal(skuRes[0].sku, "S2");
assert.ok(skuRes[0].profit < 0, "Expected S2 to be flagged as loss");
const zipBytes = ecoCtx.buildZipUint8Array([{ name: "hello.txt", bytes: new TextEncoder().encode("abc") }]);
assert.equal(zipBytes[0], 0x50); // 'P'
assert.equal(zipBytes[1], 0x4b); // 'K'
assert.equal(zipBytes[2], 0x03);
assert.equal(zipBytes[3], 0x04);

// 6. Functional logic tests: Markdown -> Anki
const { ctx: ankiCtx } = runHtmlInVm("tools/md-to-anki/index.html");
const ankiRes = ankiCtx.parseMarkdownToAnki("# Python\n## Async\n- **GIL**: Mutex lock\nQ: Why?\nA: Concurrency\nQ: Why?\nA: Duplicate");
assert.equal(ankiRes.cards.length, 2);
assert.equal(ankiRes.dups, 1);
assert.equal(ankiRes.cards[0].tag, "Python::Async");

console.log("[Site Verify OK] 6 pages compiled, sitemap checked, CSV/ZIP/SKU/Anki end-to-end assertions passed.");
