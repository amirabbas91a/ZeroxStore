import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

// ============================================================================
// 1. EXTRACT REAL CODE DIRECTLY FROM PATCHED eboot.bin (v2.1.0)
// ============================================================================
const EBOOT_PATH = path.resolve(import.meta.dirname, "..", "eboot.bin");
const ebootBuf = fs.readFileSync(EBOOT_PATH);
const JS_START = 0x2608D50;
const jsEnd = ebootBuf.indexOf(0, JS_START);
const bundleJs = ebootBuf.subarray(JS_START, jsEnd).toString("utf8");

function sliceBetween(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  if (s === -1 || e === -1) throw new Error(`Slice missing: ${startMarker} .. ${endMarker}`);
  return src.slice(s, e);
}

// Verify version and branding markers inside eboot.bin JS
assert(bundleJs.includes('var VERSION = "2.1.0";'), "VERSION must be 2.1.0");
assert(bundleJs.includes('github.com/amirabbas91a/ZeroxStore'), "Updater must point to amirabbas91a/ZeroxStore");

// Extract real functions from eboot.bin JS bundle
const readJsonCode = sliceBetween(bundleJs, "// ../../../_temp/app/state/read-json.js", "// ../../../_temp/app/state/saved.js");
const sourcesCode = sliceBetween(bundleJs, "// ../../../_temp/app/state/download-sources.js", "// ../../../_temp/app/state/viking-capture.js");
const formatsCode = sliceBetween(bundleJs, "// runtime/js/download-formats.js", "// runtime/js/native.js");
const stateFormatsCode = sliceBetween(bundleJs, "// ../../../_temp/app/state/formats.js", "// ../../../_temp/app/state/page-cache.js");
const queueModuleCode = sliceBetween(bundleJs, "// ../../../_temp/app/downloads/errors.js", "// ../../../_temp/app/state/downloads.js");
const dlSettingsCode = sliceBetween(bundleJs, "var dlSchedListeners = new Set();", "function useBgm() {");

// Provide minimal React/i18n/UI stubs ONLY for non-queue UI hooks present in the extracted slice
const harnessCode = `
  const t = (k, v) => v ? k + ":" + JSON.stringify(v) : k;
  const formatBytes = (b) => b + " B";
  const formatNumber2 = (n) => String(n);
  const __toESM = (m) => m;
  const require_react = () => ({ useState: () => [null, () => {}], useEffect: () => {} });
  const SETTINGS10 = "settings.json";
  let __memSettings = {};
  const loadList = (_f, _w) => ({ ...__memSettings });
  const saveList = (_f, _w, obj) => { __memSettings = { ...obj }; };
  const import_react96 = { useState: () => [null, () => {}], useEffect: () => {} };
  const Downloads = { setRateLimit: () => {} };
  const downloadQueue = () => globalThis.__activeQueue;
  const fs = globalThis.__hostFs;
  ${readJsonCode}
  ${sourcesCode}
  ${formatsCode}
  ${stateFormatsCode}
  ${dlSettingsCode}
  ${queueModuleCode}
  globalThis.__exported = {
    createDownloadQueue,
    createSourceResolver,
    DownloadFormats,
    getDlSettings,
    setDlSettings,
    inDlSchedule,
    restore,
    reconcileJobWithDisk,
    __setMemSettings: (s) => { __memSettings = { ...s }; }
  };
`;

// ============================================================================
// 2. REAL DISK FILESYSTEM ADAPTER + REAL HTTP RANGE DOWNLOADER
// ============================================================================
function makeNodeFs(rootTmp) {
  const mapPath = (p) => {
    if (p.startsWith("/")) return path.join(rootTmp, p.slice(1));
    return path.join(rootTmp, p);
  };
  return {
    exists: (p) => fs.existsSync(mapPath(p)),
    stat: (p) => {
      try {
        const st = fs.statSync(mapPath(p));
        return { isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size, modified: st.mtimeMs };
      } catch {
        return null;
      }
    },
    mkdir: (p, opts) => fs.mkdirSync(mapPath(p), { recursive: Boolean(opts?.recursive) }),
    readFile: (p, opts) => {
      const mp = mapPath(p);
      if (opts?.length) {
        const fd = fs.openSync(mp, "r");
        try {
          const buf = Buffer.alloc(opts.length);
          const n = fs.readSync(fd, buf, 0, opts.length, 0);
          return buf.subarray(0, n).toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      }
      return fs.readFileSync(mp, "utf8");
    },
    writeFile: (p, content) => {
      const mp = mapPath(p);
      fs.mkdirSync(path.dirname(mp), { recursive: true });
      fs.writeFileSync(mp, content, "utf8");
    },
    rename: (a, b) => fs.renameSync(mapPath(a), mapPath(b)),
    remove: (p) => fs.rmSync(mapPath(p), { recursive: true, force: true }),
    removeAsync: async (p) => fs.rmSync(mapPath(p), { recursive: true, force: true }),
    readDir: (p) => fs.readdirSync(mapPath(p), { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile() })),
    diskUsage: () => ({ total: 100 * 1024 ** 3, free: 80 * 1024 ** 3 }),
    mounts: () => [{ path: "/data" }, { path: "/mnt/usb0" }],
    _mapPath: mapPath,
  };
}

function makeHttpAdapter() {
  return {
    async request(url, opts = {}) {
      return await new Promise((resolve, reject) => {
        const req = http.request(url, { method: opts.method || "GET", headers: opts.headers || {} }, (res) => {
          const chunks = [];
          let bytes = 0;
          res.on("data", (c) => {
            bytes += c.length;
            if (!opts.maxBytes || bytes <= opts.maxBytes) chunks.push(c);
          });
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode,
              ok: res.statusCode >= 200 && res.statusCode < 300,
              url,
              headers: res.headers,
              text: async () => body,
              json: async () => JSON.parse(body),
            });
          });
        });
        req.on("error", reject);
        if (opts.signal) {
          if (opts.signal.aborted) { req.destroy(new Error("aborted")); return; }
          opts.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
        }
        req.end();
      });
    },
  };
}

function makeRangeDownloader(nodeFs, { onChunkHook } = {}) {
  return {
    enqueue(opts) {
      const partDiskPath = nodeFs._mapPath(`${opts.destination}.part`);
      const finalDiskPath = nodeFs._mapPath(opts.destination);
      const resumeDiskPath = nodeFs._mapPath(`${opts.destination}.resume`);
      const listeners = new Set();
      let cancelled = false;
      let reqRef = null;
      const snap = { state: "connecting", written: 0, completedBytes: 0, total: opts.expectedBytes ?? null, bytesPerSecond: 0, connections: 1, received: 0 };
      const emit = () => { for (const fn of listeners) fn({ ...snap }); };

      const done = new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(partDiskPath), { recursive: true });
        let startOffset = 0;
        if (opts.resume && fs.existsSync(partDiskPath)) {
          startOffset = fs.statSync(partDiskPath).size;
          snap.written = startOffset;
          snap.completedBytes = startOffset;
        } else if (!opts.resume && fs.existsSync(partDiskPath)) {
          fs.rmSync(partDiskPath, { force: true });
        }

        const headers = { ...(opts.headers || {}) };
        if (startOffset > 0) headers["Range"] = `bytes=${startOffset}-`;

        reqRef = http.request(opts.url, { headers }, (res) => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          // If server does not support Range (returns 200 when we asked for Range), reset .part cleanly
          if (startOffset > 0 && res.statusCode === 200) {
            startOffset = 0;
            fs.rmSync(partDiskPath, { force: true });
          }
          const cr = res.headers["content-range"];
          const cl = Number(res.headers["content-length"] || 0);
          const total = cr ? Number(String(cr).split("/")[1]) : (startOffset + cl) || opts.expectedBytes || null;
          snap.total = total;
          snap.state = "downloading";
          const fd = fs.openSync(partDiskPath, startOffset > 0 ? "a" : "w");
          let written = startOffset;
          let closed = false;
          const finishFd = () => { if (!closed) { closed = true; fs.closeSync(fd); } };

          res.on("data", (chunk) => {
            if (cancelled) return;
            fs.writeSync(fd, chunk);
            written += chunk.length;
            snap.written = written;
            snap.completedBytes = written;
            snap.received += chunk.length;
            snap.bytesPerSecond = 512 * 1024;
            fs.writeFileSync(resumeDiskPath, JSON.stringify({ written, total, updatedAt: Date.now() }));
            emit();
            if (onChunkHook) {
              try { onChunkHook({ written, total, chunk, cancel: () => { cancelled = true; reqRef?.destroy(); finishFd(); reject(new Error("cancelled")); } }); } catch (e) { finishFd(); reject(e); }
            }
          });
          res.on("end", () => {
            finishFd();
            if (cancelled) return;
            if (!res.complete) {
              reject(new Error("ECONNRESET premature end of stream"));
              return;
            }
            if (total && written < total) {
              reject(new Error(`ECONNRESET truncated ${written}/${total}`));
              return;
            }
            fs.renameSync(partDiskPath, finalDiskPath);
            fs.rmSync(resumeDiskPath, { force: true });
            snap.state = "completed";
            snap.written = written;
            snap.completedBytes = written;
            emit();
            resolve({ written });
          });
          res.on("error", (err) => {
            finishFd();
            reject(err);
          });
          res.on("close", () => {
            finishFd();
            if (!cancelled && !res.complete) reject(new Error("ECONNRESET socket closed prematurely"));
          });
        });
        reqRef.on("error", (err) => reject(err));
        reqRef.end();
      });

      return {
        snapshot: snap,
        done,
        subscribe: (fn) => { listeners.add(fn); fn({ ...snap }); return () => listeners.delete(fn); },
        cancel: () => {
          cancelled = true;
          reqRef?.destroy(new Error("cancelled"));
        },
      };
    },
  };
}

// ============================================================================
// 3. LOCAL TEST HTTP SERVER (206 RANGE, 200 NON-RANGE, 403 EXPIRED, DROP)
// ============================================================================
const PAYLOAD_SIZE = 256 * 1024; // 256 KiB payload in 16 KiB chunks
const PAYLOAD = crypto.randomBytes(PAYLOAD_SIZE);
const PAYLOAD_SHA = crypto.createHash("sha256").update(PAYLOAD).digest("hex");

let serverMode = { dropAfterBytes: null, expireOldToken: false, noRange: false, offline: false, totalRangeRequests: 0 };

const server = http.createServer((req, res) => {
  if (serverMode.offline) {
    req.socket.destroy();
    return;
  }
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/file-expiring" && serverMode.expireOldToken) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Expired");
    return;
  }
  if (u.pathname === "/resolve-fresh") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/file-fresh.bin` }));
    return;
  }
  const rangeHdr = req.headers.range;
  if (rangeHdr && !serverMode.noRange) {
    serverMode.totalRangeRequests++;
    const m = /bytes=(\d+)-(\d*)/.exec(rangeHdr);
    const start = Number(m[1]);
    const end = m[2] ? Math.min(PAYLOAD_SIZE - 1, Number(m[2])) : PAYLOAD_SIZE - 1;
    res.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${PAYLOAD_SIZE}`,
      "Content-Length": end - start + 1,
    });
    let pos = start;
    let sentThisReq = 0;
    const sendNext = () => {
      if (pos > end || res.destroyed) { res.end(); return; }
      const sliceEnd = Math.min(end + 1, pos + 16384);
      res.write(PAYLOAD.subarray(pos, sliceEnd));
      sentThisReq += sliceEnd - pos;
      pos = sliceEnd;
      if (serverMode.dropAfterBytes && sentThisReq >= serverMode.dropAfterBytes) {
        setTimeout(() => req.socket.destroy(), 5);
        return;
      }
      setTimeout(sendNext, 4);
    };
    sendNext();
    return;
  }
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": PAYLOAD_SIZE });
  let pos = 0;
  let sent200 = 0;
  const sendNext = () => {
    if (pos >= PAYLOAD_SIZE || res.destroyed) { res.end(); return; }
    const sliceEnd = Math.min(PAYLOAD_SIZE, pos + 16384);
    res.write(PAYLOAD.subarray(pos, sliceEnd));
    sent200 += sliceEnd - pos;
    pos = sliceEnd;
    if (serverMode.dropAfterBytes && sent200 >= serverMode.dropAfterBytes) {
      setTimeout(() => req.socket.destroy(), 5);
      return;
    }
    setTimeout(sendNext, 4);
  };
  sendNext();
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

function bootEngine(tmpDir, downloaderOpts = {}, customSources = null) {
  const nodeFs = makeNodeFs(tmpDir);
  globalThis.__hostFs = nodeFs;
  const ctx = vm.createContext({
    ...globalThis,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, TextEncoder, TextDecoder,
  });
  vm.runInContext(harnessCode, ctx);
  const exp = ctx.__exported;
  const httpAdapter = makeHttpAdapter();
  const q = exp.createDownloadQueue({
    fs: nodeFs,
    downloads: makeRangeDownloader(nodeFs, downloaderOpts),
    http: httpAdapter,
    formats: exp.DownloadFormats,
    dataDir: "/data",
    stateDir: "/data/ps5-react/PPSA99059/queue",
    platform: "desktop",
    notifications: { show: () => {} },
    power: { keepAwake: () => {} },
    linking: { openURL: () => true },
    sources: customSources || exp.createSourceResolver({ http: httpAdapter }),
    archives: null,
    packages: null,
    releasesOf: () => [],
    browserCapture: null,
    stallMs: 60000,
    busyRetryDelays: [100, 200],
  });
  ctx.__activeQueue = q;
  return { q, exp, nodeFs };
}

const waitUntil = async (pred, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitUntil timeout");
};

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "zerox-test-"));

try {
  // TEST 1: Download to >=37%, close app abruptly, reopen -> resumes from >=37% & SHA-256 matches
  {
    const dir = path.join(tmpBase, "t1");
    let abortedAt37 = false;
    let { q, nodeFs } = bootEngine(dir, {
      onChunkHook: ({ written, total, cancel }) => {
        if (!abortedAt37 && written >= total * 0.37) {
          abortedAt37 = true;
          q.flushNow();
          cancel();
        }
      },
    });
    const game = { id: "PPSA10001", title: "Test Game 1" };
    const rel = { id: "rel1", filename: "game1.pkg", url: `${BASE}/file.pkg`, sizeBytes: PAYLOAD_SIZE, provider: "direct", format: "pkg" };
    const id = q.enqueue(game, rel, "/mnt/usb0");
    await waitUntil(() => abortedAt37);
    const savedBeforeClose = q.snapshot().find((j) => j.id === id);
    assert(savedBeforeClose.written >= PAYLOAD_SIZE * 0.37, "Test 1: must reach >=37% before close");
    q.dispose();

    // Reopen fresh instance from disk
    const boot2 = bootEngine(dir);
    const recovered = boot2.q.snapshot().find((j) => j.id === id);
    assert(recovered.written >= PAYLOAD_SIZE * 0.37, "Test 1: recovered written must be >=37%");
    assert.equal(recovered.recoveredFromDisk, true, "Test 1: must verify partial file on disk");
    boot2.q.resume(id);
    try {
      await waitUntil(() => {
        const st = boot2.q.snapshot().find((j) => j.id === id)?.state;
        return st === "file-downloaded" || st === "installer-required" || st === "downloaded";
      });
    } catch (e) {
      console.error("Test 1 state:", boot2.q.snapshot());
      throw e;
    }
    const outPath = boot2.q.snapshot().find((j) => j.id === id).artifact.destination;
    const outSha = crypto.createHash("sha256").update(fs.readFileSync(boot2.nodeFs._mapPath(outPath))).digest("hex");
    assert.equal(outSha, PAYLOAD_SHA, "Test 1: final file SHA-256 must match");
    boot2.q.dispose();
    console.log("PASS Test 1: ~37% abrupt close -> cold restart -> smart resume -> exact SHA-256");
  }

  // TEST 2: Download to >=63%, simulate 3 consecutive sudden console power-offs (with lagged downloads.json!)
  {
    const dir = path.join(tmpBase, "t2");
    let stopped63 = false;
    let boot1 = bootEngine(dir, {
      onChunkHook: ({ written, total, cancel }) => {
        if (!stopped63 && written >= total * 0.63) {
          stopped63 = true;
          cancel(); // abrupt power-off without calling flushNow!
        }
      },
    });
    const id = boot1.q.enqueue({ id: "PPSA10002", title: "Test Game 2" }, { id: "rel2", filename: "game2.pkg", url: `${BASE}/file.pkg`, sizeBytes: PAYLOAD_SIZE, provider: "direct", format: "pkg" }, "/mnt/usb0");
    await waitUntil(() => stopped63);
    // Simulate queue still saying "downloading" at power loss across 3 restarts
    boot1.q.dispose();
    for (let r = 1; r <= 3; r++) {
      const bi = bootEngine(dir);
      const snap = bi.q.snapshot().find((j) => j.id === id);
      assert(snap.written >= PAYLOAD_SIZE * 0.63, `Test 2 reboot #${r}: written >=63% preserved`);
      assert(snap.state !== "failed", `Test 2 reboot #${r}: must never fail or wipe after >2 reboots`);
      if (r < 3) bi.q.pause(id); // pause/reboot cycle
      else {
        bi.q.resume(id);
        await waitUntil(() => ["file-downloaded", "installer-required", "downloaded"].includes(bi.q.snapshot().find((j) => j.id === id)?.state));
        const outPath = bi.q.snapshot().find((j) => j.id === id).artifact.destination;
        const outSha = crypto.createHash("sha256").update(fs.readFileSync(bi.nodeFs._mapPath(outPath))).digest("hex");
        assert.equal(outSha, PAYLOAD_SHA, "Test 2: final file SHA-256 must match");
      }
      bi.q.dispose();
    }
    console.log("PASS Test 2: ~63% sudden power-off across 3 consecutive reboots -> exact SHA-256");
  }

  // TEST 3: Internet disconnect mid-download -> preserves partial & auto-retries -> completes
  {
    const dir = path.join(tmpBase, "t3");
    serverMode.dropAfterBytes = 64 * 1024;
    const b3 = bootEngine(dir);
    b3.exp.setDlSettings({ dlMaxRetries: 3 });
    const id = b3.q.enqueue({ id: "PPSA10003", title: "Test Game 3" }, { id: "rel3", filename: "game3.pkg", url: `${BASE}/file.pkg`, sizeBytes: PAYLOAD_SIZE, provider: "direct", format: "pkg" }, "/mnt/usb0");
    try {
      await waitUntil(() => (b3.q.snapshot().find((j) => j.id === id)?.netRetries || 0) >= 1, 3000);
    } catch (e) {
      console.error("Test 3 snap:", b3.q.snapshot());
      throw e;
    }
    const mid = b3.q.snapshot().find((j) => j.id === id);
    assert(fs.existsSync(b3.nodeFs._mapPath(`${mid.artifact.destination}.part`)), "Test 3: .part must survive disconnect");
    assert(mid.written >= 64 * 1024, "Test 3: written bytes preserved on disconnect");
    serverMode.dropAfterBytes = null;
    // Trigger retry immediately instead of waiting full 8s timer in unit test
    b3.q.resume(id);
    await waitUntil(() => ["file-downloaded", "installer-required", "downloaded"].includes(b3.q.snapshot().find((j) => j.id === id)?.state));
    const outSha = crypto.createHash("sha256").update(fs.readFileSync(b3.nodeFs._mapPath(mid.artifact.destination))).digest("hex");
    assert.equal(outSha, PAYLOAD_SHA, "Test 3: final file SHA-256 must match after disconnect");
    b3.q.dispose();
    console.log("PASS Test 3: Network disconnect mid-stream -> .part preserved -> retry completes");
  }

  // TEST 4: Concurrent multi-download state preservation (paused + queued + active across reboot)
  {
    const dir = path.join(tmpBase, "t4");
    let pauseFirst = false;
    const b4 = bootEngine(dir, {
      onChunkHook: ({ written, total, cancel }) => {
        if (!pauseFirst && written >= total * 0.25) {
          pauseFirst = true;
          b4.q.pause("PPSA20001/r1");
          cancel();
        }
      },
    });
    const id1 = b4.q.enqueue({ id: "PPSA20001", title: "Multi 1" }, { id: "r1", filename: "m1.pkg", url: `${BASE}/file.pkg`, sizeBytes: PAYLOAD_SIZE, provider: "direct", format: "pkg" }, "/mnt/usb0");
    const id2 = b4.q.enqueue({ id: "PPSA20002", title: "Multi 2" }, { id: "r2", filename: "m2.pkg", url: `${BASE}/file.pkg`, sizeBytes: PAYLOAD_SIZE, provider: "direct", format: "pkg" }, "/mnt/usb0");
    const id3 = b4.q.enqueue({ id: "PPSA20003", title: "Multi 3" }, { id: "r3", filename: "m3.pkg", url: `${BASE}/file.pkg`, sizeBytes: PAYLOAD_SIZE, provider: "direct", format: "pkg" }, "/mnt/usb0");
    await waitUntil(() => pauseFirst && b4.q.snapshot().find((j) => j.id === id1)?.state === "paused");
    b4.q.pause(id3);
    b4.q.flushNow();
    b4.q.dispose();
    await new Promise((r) => setTimeout(r, 80));

    const b4b = bootEngine(dir);
    const s1 = b4b.q.snapshot().find((j) => j.id === id1);
    const s2 = b4b.q.snapshot().find((j) => j.id === id2);
    const s3 = b4b.q.snapshot().find((j) => j.id === id3);
    assert.equal(s1.state, "paused", "Test 4: paused job 1 stays paused");
    assert(s1.written >= PAYLOAD_SIZE * 0.25, "Test 4: job 1 keeps >=25% bytes");
    assert.equal(s3.state, "paused", "Test 4: paused job 3 stays paused");
    assert(s2.state !== "paused", "Test 4: unpaused job 2 stays queued/active");
    await waitUntil(() => ["file-downloaded", "installer-required", "downloaded"].includes(b4b.q.snapshot().find((j) => j.id === id2)?.state));
    assert.equal(b4b.q.snapshot().find((j) => j.id === id1)?.state, "paused", "Test 4: job 1 still paused after job 2 finishes");
    assert.equal(b4b.q.snapshot().find((j) => j.id === id3)?.state, "paused", "Test 4: job 3 still paused after job 2 finishes");
    b4b.q.dispose();
    console.log("PASS Test 4: Concurrent multi-download pause/resume state intact after reboot");
  }

  // TEST 5: Smart Resume (5a: Expired signed URL re-resolve preserving .part; 5b: Non-Range 200 fallback; 5c: IDM Schedule gate)
  {
    const dir = path.join(tmpBase, "t5");
    let firstStop = false;
    let resolveCount = 0;
    const customSources = {
      resolve: async () => {
        resolveCount++;
        return { url: resolveCount === 1 ? `${BASE}/file-expiring` : `${BASE}/file-fresh`, headers: {} };
      },
    };
    const b5a = bootEngine(dir, {
      onChunkHook: ({ written, total, cancel }) => {
        if (!firstStop && written >= total * 0.45) {
          firstStop = true;
          cancel();
        }
      },
    }, customSources);
    const id = b5a.q.enqueue({ id: "PPSA30001", title: "Expiring Host" }, { id: "r5", filename: "exp.pkg", url: "https://mediafire.com/file/abc/exp.pkg", sizeBytes: PAYLOAD_SIZE, provider: "mediafire", format: "pkg" }, "/mnt/usb0");
    await waitUntil(() => firstStop);
    b5a.q.dispose();

    // Expire old link while paused
    serverMode.expireOldToken = true;
    const b5b = bootEngine(dir, {}, customSources);
    b5b.q.resume(id);
    await waitUntil(() => ["file-downloaded", "installer-required", "downloaded"].includes(b5b.q.snapshot().find((j) => j.id === id)?.state));
    assert(resolveCount >= 2, "Test 5a: Smart Resume must re-resolve expired link while keeping .part");
    const sha5a = crypto.createHash("sha256").update(fs.readFileSync(b5b.nodeFs._mapPath(b5b.q.snapshot().find((j) => j.id === id).artifact.destination))).digest("hex");
    assert.equal(sha5a, PAYLOAD_SHA, "Test 5a: re-resolved resume output SHA-256 matches");
    b5b.q.dispose();
    serverMode.expireOldToken = false;

    // Test 5b: Non-Range server fallback
    const dirNR = path.join(tmpBase, "t5nr");
    serverMode.noRange = true;
    let nrStop = false;
    const bNR = bootEngine(dirNR, {
      onChunkHook: ({ written, total, cancel }) => {
        if (!nrStop && written >= total * 0.30) {
          nrStop = true;
          cancel();
        }
      },
    });
    const idNR = bNR.q.enqueue({ id: "PPSA30002", title: "NoRange Host" }, { id: "rnr", filename: "nr.pkg", url: `${BASE}/file.pkg`, sizeBytes: PAYLOAD_SIZE, provider: "direct", format: "pkg" }, "/mnt/usb0");
    await waitUntil(() => nrStop);
    bNR.q.dispose();
    const bNR2 = bootEngine(dirNR);
    bNR2.q.resume(idNR);
    await waitUntil(() => ["file-downloaded", "installer-required", "downloaded"].includes(bNR2.q.snapshot().find((j) => j.id === idNR)?.state));
    assert.equal(bNR2.q.snapshot().find((j) => j.id === idNR)?.rangeSupported, false, "Test 5b: detects non-Range server");
    const shaNR = crypto.createHash("sha256").update(fs.readFileSync(bNR2.nodeFs._mapPath(bNR2.q.snapshot().find((j) => j.id === idNR).artifact.destination))).digest("hex");
    assert.equal(shaNR, PAYLOAD_SHA, "Test 5b: non-Range fallback produces exact SHA-256");
    bNR2.q.dispose();
    serverMode.noRange = false;

    // Test 5c: IDM Schedule gate blocks outside window & allows inside window
    const curHour = new Date().getHours();
    const offStart = (curHour + 2) % 24;
    const offStop = (curHour + 4) % 24;
    const dirSch = path.join(tmpBase, "t5sch");
    const bSch = bootEngine(dirSch);
    bSch.exp.setDlSettings({ dlScheduleOn: true, dlStartHour: offStart, dlStopHour: offStop });
    assert.equal(bSch.exp.inDlSchedule(), false, "Test 5c: outside IDM window");
    const idSch = bSch.q.enqueue({ id: "PPSA30003", title: "Scheduled Game" }, { id: "rsch", filename: "sch.pkg", url: `${BASE}/file.pkg`, sizeBytes: PAYLOAD_SIZE, provider: "direct", format: "pkg" }, "/mnt/usb0");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(bSch.q.snapshot().find((j) => j.id === idSch)?.state, "queued", "Test 5c: stays queued outside IDM window");
    bSch.exp.setDlSettings({ dlScheduleOn: true, dlStartHour: curHour, dlStopHour: (curHour + 2) % 24 });
    assert.equal(bSch.exp.inDlSchedule(), true, "Test 5c: inside IDM window");
    await waitUntil(() => ["file-downloaded", "installer-required", "downloaded"].includes(bSch.q.snapshot().find((j) => j.id === idSch)?.state));
    bSch.q.dispose();
    console.log("PASS Test 5: Expired-link Smart Resume + Non-Range fallback + IDM Scheduler gate");
  }
} finally {
  server.close();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}
