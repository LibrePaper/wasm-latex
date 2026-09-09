// Plain node:assert tests for bundle-mode.js. Run with:
//   node wasm-build/bundle-mode.test.cjs
//
// bundle-mode.js is written to be importScripts()'d after kpse-resolve.js in
// a worker (or vm context, see tools/build-format.mjs), where sha256Hex,
// readTar, buildNameIndex and resolveName become ambient globals. Under a
// plain node `require`, this test recreates that: it copies kpse-resolve's
// exports onto `global` before requiring bundle-mode.js, exactly as
// importScripts would have made them ambient.
"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");

Object.assign(global, require("./kpse-resolve.cjs"));
const BundleMode = require("./bundle-mode.js");

let passed = 0;
const tests = [];
// Tests run strictly one at a time, each fully awaited before the next
// starts (see main() at the bottom): several bodies below reassign the
// global XMLHttpRequest/Response fakes (bundle-mode.js reads them as
// ambient globals, same as importScripts in a worker), so two tests'
// asynchronous continuations must never interleave.
function test(name, fn) {
    tests.push({ name: name, fn: fn });
}

// --- A tiny ustar writer (single-member, short names only — enough for these
// fixtures; kpse-resolve.test.cjs exercises the long-name/multi-member cases). ---

function padBlock(buf) {
    const rem = buf.length % 512;
    return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem)]);
}
function octalField(value, len) {
    const s = value.toString(8);
    return Buffer.from("0".repeat(Math.max(0, len - 1 - s.length)) + s + "\0", "ascii");
}
function checksumHeader(header) {
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < copy.length; i++) sum += copy[i];
    header.set(octalField(sum, 7), 148);
    header[155] = 0x20;
}
function makeHeader(name, size) {
    const header = Buffer.alloc(512);
    header.write(name.slice(0, 100), 0, "ascii");
    header.write("0000644\0", 100, "ascii");
    header.set(octalField(0, 8), 108);
    header.set(octalField(0, 8), 116);
    header.set(octalField(size, 12), 124);
    header.set(octalField(0, 12), 136);
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    checksumHeader(header);
    return header;
}
function buildTar(members) {
    const chunks = members
        .slice()
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((m) => {
            const buf = Buffer.from(m.data, "utf8");
            return Buffer.concat([makeHeader(m.name, buf.length), padBlock(buf)]);
        });
    chunks.push(Buffer.alloc(1024));
    return Buffer.concat(chunks);
}
function toU8(buf) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
function sha256(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

// --- Fakes -------------------------------------------------------------------

function makeFakeFS() {
    const files = new Map(); // path -> Uint8Array
    const dirs = new Set(["/"]);
    return {
        files: files,
        mkdirTree: function(path) {
            var parts = path.split("/").filter(Boolean);
            var cur = "";
            for (var i = 0; i < parts.length; i++) {
                cur += "/" + parts[i];
                dirs.add(cur);
            }
        },
        writeFile: function(path, data) {
            files.set(path, data instanceof Uint8Array ? data : new Uint8Array(data));
        },
        readFile: function(path) {
            if (!files.has(path)) throw new Error("ENOENT: " + path);
            return files.get(path);
        }
    };
}

function makeFakeXHR() {
    var routes = {}; // url -> { status, body: Uint8Array } | { throwErr: true }
    var calls = [];
    function FakeXHR() {
        this.status = 0;
        this.response = null;
        this.timeout = 0;
        this.responseType = "";
    }
    FakeXHR.prototype.open = function(method, url) { this._url = url; };
    FakeXHR.prototype.send = function() {
        calls.push(this._url);
        var route = routes[this._url];
        if (!route) { this.status = 404; this.response = new ArrayBuffer(0); return; }
        if (route.throwErr) throw new Error("simulated transport error");
        this.status = route.status;
        var b = route.body;
        this.response = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    };
    return { ctor: FakeXHR, routes: routes, calls: calls };
}

function makeFakeCacheStorage() {
    var named = new Map(); // cache name -> Map(url -> Uint8Array)
    function FakeResponse(bytes) {
        this._bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    }
    FakeResponse.prototype.arrayBuffer = function() {
        var b = this._bytes;
        return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    };
    function FakeCache(store) {
        this.store = store;
    }
    FakeCache.prototype.keys = function() {
        var store = this.store;
        return Promise.resolve(Array.from(store.keys()).map(function(url) { return { url: url }; }));
    };
    FakeCache.prototype.match = function(request) {
        var url = typeof request === "string" ? request : request.url;
        var bytes = this.store.get(url);
        return Promise.resolve(bytes ? new FakeResponse(bytes) : undefined);
    };
    FakeCache.prototype.put = function(url, response) {
        var store = this.store;
        return response.arrayBuffer().then(function(buf) {
            store.set(url, new Uint8Array(buf));
        });
    };
    FakeCache.prototype.delete = function(request) {
        var url = typeof request === "string" ? request : request.url;
        var had = this.store.has(url);
        this.store.delete(url);
        return Promise.resolve(had);
    };
    return {
        ResponseCtor: FakeResponse,
        open: function(name) {
            if (!named.has(name)) named.set(name, new Map());
            return Promise.resolve(new FakeCache(named.get(name)));
        },
        // test helper: seed a cache entry directly, bypassing put()
        seed: function(name, url, bytes) {
            if (!named.has(name)) named.set(name, new Map());
            named.get(name).set(url, bytes);
        },
        has: function(name, url) {
            return named.has(name) && named.get(name).has(url);
        }
    };
}

// --- Fixture: one bundle, one member ------------------------------------------

const TIKZ_TAR = buildTar([{ name: "tex/latex/tikz/tikz.sty", data: "tikz sty contents" }]);
const TIKZ_U8 = toU8(TIKZ_TAR);
const TIKZ_SHA = sha256(TIKZ_TAR);

const AMSMATH_TAR = buildTar([{ name: "tex/latex/amsmath/amsmath.sty", data: "amsmath contents" }]);
const AMSMATH_U8 = toU8(AMSMATH_TAR);
const AMSMATH_SHA = sha256(AMSMATH_TAR);

function makeIndex() {
    return {
        schemaVersion: 1,
        bundles: {
            "tex/latex/tikz": { url: "b/" + TIKZ_SHA + "/tex-latex-tikz.tar", size: TIKZ_U8.length, sha256: TIKZ_SHA, files: 1 },
            "tex/latex/amsmath": { url: "b/" + AMSMATH_SHA + "/tex-latex-amsmath.tar", size: AMSMATH_U8.length, sha256: AMSMATH_SHA, files: 1 }
        },
        files: {
            "tex/latex/tikz/tikz.sty": "tex/latex/tikz",
            "tex/latex/amsmath/amsmath.sty": "tex/latex/amsmath"
        }
    };
}

const ENDPOINT = "https://cdn.example/";

function makeEnv(overrides) {
    var fs = makeFakeFS();
    var xhr = makeFakeXHR();
    var cacheStorage = makeFakeCacheStorage();
    global.XMLHttpRequest = xhr.ctor;
    global.Response = cacheStorage.ResponseCtor;
    var evidenceLog = [];
    var env = {
        FS: fs,
        texmfRoot: "/texmf",
        workRoot: "/work",
        endpoint: function() { return ENDPOINT; },
        postMessage: function() {},
        evidence: function(reqname, format, outcome, attempts) {
            evidenceLog.push({ reqname: reqname, format: format, outcome: outcome, attempts: attempts });
        },
        caches: cacheStorage
    };
    for (var k in overrides) env[k] = overrides[k];
    return { env: env, fs: fs, xhr: xhr, cacheStorage: cacheStorage, evidenceLog: evidenceLog };
}

// --- Tests ---------------------------------------------------------------------

test("resolve hits: fetches once, unpacks, verifies digest, writes back to Cache Storage", () => {
    const { env, fs, xhr, cacheStorage } = makeEnv();
    xhr.routes[ENDPOINT + "b/" + TIKZ_SHA + "/tex-latex-tikz.tar"] = { status: 200, body: TIKZ_U8 };
    const bm = BundleMode.create(env);
    bm.loadIndex(JSON.stringify(makeIndex()));

    const result = bm.resolve("tikz.sty", 26);
    assert.strictEqual(result.path, "/texmf/tex/latex/tikz/tikz.sty");
    assert.strictEqual(
        Buffer.from(fs.readFile(result.path)).toString("utf8"),
        "tikz sty contents"
    );
    assert.strictEqual(xhr.calls.length, 1);

    // A second resolve for a sibling in the same bundle must not re-fetch.
    bm.resolve("tikz.sty", 26);
    assert.strictEqual(xhr.calls.length, 1);

    // Cache Storage write-back is fire-and-forget (open().then(cache => cache.put(...))),
    // several microtask turns deep; a setImmediate flushes them all before checking.
    return new Promise((resolve) => setImmediate(resolve)).then(() => {
        assert.ok(cacheStorage.has("wasmtex-bundles", ENDPOINT + "b/" + TIKZ_SHA + "/tex-latex-tikz.tar"));
    });
});

test("absence: a name absent from the index makes no request", () => {
    const { env, xhr } = makeEnv();
    const bm = BundleMode.create(env);
    bm.loadIndex(JSON.stringify(makeIndex()));

    const result = bm.resolve("nosuchfile.sty", 26);
    assert.deepStrictEqual(result, { absent: true });
    assert.strictEqual(xhr.calls.length, 0);
});

test("digest mismatch: error result, bundle not unpacked", () => {
    const { env, fs, xhr } = makeEnv();
    // Serve AMSMATH bytes under the tikz bundle's URL — sha256 will not match
    // the index's recorded digest for tex/latex/tikz.
    xhr.routes[ENDPOINT + "b/" + TIKZ_SHA + "/tex-latex-tikz.tar"] = { status: 200, body: AMSMATH_U8 };
    const bm = BundleMode.create(env);
    bm.loadIndex(JSON.stringify(makeIndex()));

    const result = bm.resolve("tikz.sty", 26);
    assert.deepStrictEqual(result, { error: "digest-mismatch", bundle: "tex/latex/tikz" });
    assert.ok(!bm.loaded.has("tex/latex/tikz"));
    assert.throws(() => fs.readFile("/texmf/tex/latex/tikz/tikz.sty"));
});

test("transport error does not poison: a later resolve retries the fetch", () => {
    const { env, xhr } = makeEnv();
    xhr.routes[ENDPOINT + "b/" + TIKZ_SHA + "/tex-latex-tikz.tar"] = { throwErr: true };
    const bm = BundleMode.create(env);
    bm.loadIndex(JSON.stringify(makeIndex()));

    const first = bm.resolve("tikz.sty", 26);
    assert.deepStrictEqual(first, { error: "transport-error", bundle: "tex/latex/tikz" });
    assert.ok(!bm.loaded.has("tex/latex/tikz"));

    // Fix the route and resolve again: bundle-mode itself keeps no negative
    // cache for a transport error, so it must attempt the fetch again (the
    // caller's own 404 cache is what must stay unpoisoned — see
    // resolveViaBundleIndex in pdftex-worker.js, which only writes
    // texlive404_cache on `absent`, never on `error`).
    xhr.routes[ENDPOINT + "b/" + TIKZ_SHA + "/tex-latex-tikz.tar"] = { status: 200, body: TIKZ_U8 };
    const second = bm.resolve("tikz.sty", 26);
    assert.strictEqual(second.path, "/texmf/tex/latex/tikz/tikz.sty");
    assert.strictEqual(xhr.calls.length, 2);
});

test("preload scope: restores only the named bundles and reports skipped", () => {
    const { env, fs, xhr, cacheStorage } = makeEnv();
    cacheStorage.seed("wasmtex-bundles", ENDPOINT + "b/" + TIKZ_SHA + "/tex-latex-tikz.tar", TIKZ_U8);
    cacheStorage.seed("wasmtex-bundles", ENDPOINT + "b/" + AMSMATH_SHA + "/tex-latex-amsmath.tar", AMSMATH_U8);
    const bm = BundleMode.create(env);
    bm.loadIndex(JSON.stringify(makeIndex()));

    return bm.preloadFromCacheStorage(["tex/latex/tikz"]).then((result) => {
        assert.strictEqual(result.cached, 1);
        assert.strictEqual(result.skipped, 1);
        assert.ok(bm.loaded.has("tex/latex/tikz"));
        assert.ok(!bm.loaded.has("tex/latex/amsmath"));
        assert.strictEqual(xhr.calls.length, 0); // preload never hits the network

        // The unscoped bundle is still unpacked on demand, from the network,
        // since it was skipped rather than restored.
        xhr.routes[ENDPOINT + "b/" + AMSMATH_SHA + "/tex-latex-amsmath.tar"] = { status: 200, body: AMSMATH_U8 };
        const result2 = bm.resolve("amsmath.sty", 26);
        assert.strictEqual(result2.path, "/texmf/tex/latex/amsmath/amsmath.sty");
    });
});

test("preload without scope restores every cached bundle matching the index", () => {
    const { env, cacheStorage } = makeEnv();
    cacheStorage.seed("wasmtex-bundles", ENDPOINT + "b/" + TIKZ_SHA + "/tex-latex-tikz.tar", TIKZ_U8);
    cacheStorage.seed("wasmtex-bundles", ENDPOINT + "b/" + AMSMATH_SHA + "/tex-latex-amsmath.tar", AMSMATH_U8);
    const bm = BundleMode.create(env);
    bm.loadIndex(JSON.stringify(makeIndex()));

    return bm.preloadFromCacheStorage().then((result) => {
        assert.strictEqual(result.cached, 2);
        assert.strictEqual(result.skipped, 0);
        assert.ok(bm.loaded.has("tex/latex/tikz"));
        assert.ok(bm.loaded.has("tex/latex/amsmath"));
    });
});

test("stale cache entry (digest no longer matches) is deleted, not unpacked or counted", () => {
    const { env, cacheStorage } = makeEnv();
    const url = ENDPOINT + "b/" + TIKZ_SHA + "/tex-latex-tikz.tar";
    // Seed the cache with bytes that do NOT match the index's recorded digest
    // for this bundle — as if the release rotated under the cached entry.
    cacheStorage.seed("wasmtex-bundles", url, AMSMATH_U8);
    const bm = BundleMode.create(env);
    bm.loadIndex(JSON.stringify(makeIndex()));

    return bm.preloadFromCacheStorage().then((result) => {
        // Only the stale tikz entry is in the cache at all (amsmath was never
        // seeded); it is deleted rather than counted as cached or skipped.
        assert.strictEqual(result.cached, 0);
        assert.strictEqual(result.skipped, 0);
        assert.ok(!bm.loaded.has("tex/latex/tikz"));
        assert.ok(!cacheStorage.has("wasmtex-bundles", url), "stale entry must be deleted from Cache Storage");
    });
});

async function main() {
    for (const t of tests) {
        await t.fn();
        passed++;
        console.log("ok - " + t.name);
    }
    console.log(passed + " tests passed");
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
