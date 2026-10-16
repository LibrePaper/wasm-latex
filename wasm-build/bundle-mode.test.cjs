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

// --- A tiny ustar writer (single-member, short names only; enough for these
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



const TIKZ_URL = ENDPOINT + "b/" + TIKZ_SHA + "/tex-latex-tikz.tar";
const AMSMATH_URL = ENDPOINT + "b/" + AMSMATH_SHA + "/tex-latex-amsmath.tar";

function makeEnv(overrides) {
    var fs = makeFakeFS();
    var xhr = makeFakeXHR();
    global.XMLHttpRequest = xhr.ctor;
    var evidenceLog = [];
    var messages = []; // every env.postMessage call: { message, transfer }
    var env = {
        FS: fs,
        texmfRoot: "/texmf",
        workRoot: "/work",
        endpoint: function() { return ENDPOINT; },
        postMessage: function(message, transfer) { messages.push({ message: message, transfer: transfer }); },
        evidence: function(reqname, format, outcome, attempts) {
            evidenceLog.push({ reqname: reqname, format: format, outcome: outcome, attempts: attempts });
        }
    };
    for (var k in overrides) env[k] = overrides[k];
    return { env: env, fs: fs, xhr: xhr, evidenceLog: evidenceLog, messages: messages };
}

function toBuffer(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// Create an instance with the index stored (not parsed) via the message.
function makeInstance(index, overrides) {
    const ctx = makeEnv(overrides);
    const bm = BundleMode.create(ctx.env);
    const bytes = Buffer.from(JSON.stringify(index || makeIndex()), "utf8");
    assert.strictEqual(bm.handle({ cmd: "loadbundleindex", data: toBuffer(toU8(bytes)), msgId: 1 }), true);
    ctx.bm = bm;
    return ctx;
}

function lastReply(ctx) {
    return ctx.messages[ctx.messages.length - 1];
}

function workingsetReply(ctx, limit) {
    assert.strictEqual(ctx.bm.handle({ cmd: "workingset", limit: limit, msgId: 9 }), true);
    return lastReply(ctx).message;
}

// --- Tests ---------------------------------------------------------------------

test("loadbundleindex stores the bytes, replies with the msgId and does not parse", () => {
    const ctx = makeEnv();
    const bm = BundleMode.create(ctx.env);
    assert.strictEqual(bm.active, false);
    const bytes = toU8(Buffer.from(JSON.stringify(makeIndex()), "utf8"));
    assert.strictEqual(bm.handle({ cmd: "loadbundleindex", data: toBuffer(bytes), msgId: 7 }), true);
    assert.strictEqual(bm.active, true);
    assert.deepStrictEqual(lastReply(ctx).message, { result: "ok", cmd: "loadbundleindex", msgId: 7 });
    assert.strictEqual(bm.stats.indexParsed, false);
});

test("resolve hits: fetches once, unpacks, verifies digest", () => {
    const { bm, fs, xhr } = makeInstance();
    xhr.routes[TIKZ_URL] = { status: 200, body: TIKZ_U8 };

    const result = bm.resolve("tikz.sty", 26);
    assert.strictEqual(result.path, "/texmf/tex/latex/tikz/tikz.sty");
    assert.strictEqual(result.bundle, "tex/latex/tikz");
    assert.strictEqual(
        Buffer.from(fs.readFile(result.path)).toString("utf8"),
        "tikz sty contents"
    );
    assert.strictEqual(xhr.calls.length, 1);

    // The same name again is a memo hit and must not re-fetch.
    bm.resolve("tikz.sty", 26);
    assert.strictEqual(xhr.calls.length, 1);
    assert.strictEqual(bm.stats.bundleFetches, 1);
    assert.strictEqual(bm.stats.memoMisses, 1);
    assert.strictEqual(bm.stats.memoHits, 1);
    assert.strictEqual(bm.stats.indexParsed, true);
});

test("absence: a name absent from the index makes no request", () => {
    const { bm, xhr, evidenceLog } = makeInstance();
    const result = bm.resolve("nosuchfile.sty", 26);
    assert.deepStrictEqual(result, { absent: true });
    assert.strictEqual(xhr.calls.length, 0);
    assert.strictEqual(evidenceLog[evidenceLog.length - 1].outcome, "mirror-absent");
});

test("format 10 with no index entry falls through", () => {
    const { bm } = makeInstance();
    assert.deepStrictEqual(bm.resolve("nosuch.fmt", 10), { fallthrough: true });
});

test("resolve before any index is loaded falls through and bm is inactive", () => {
    const ctx = makeEnv();
    const bm = BundleMode.create(ctx.env);
    assert.strictEqual(bm.active, false);
    assert.deepStrictEqual(bm.resolve("tikz.sty", 26), { fallthrough: true });
});

test("lazy index: nothing is parsed until the first memo miss", () => {
    const { bm } = makeInstance();
    assert.strictEqual(bm.stats.indexParsed, false);
    assert.strictEqual(bm.stats.indexParseMs, 0);
    bm.resolve("nosuchfile.sty", 26);
    assert.strictEqual(bm.stats.indexParsed, true);
});

test("a pure-memo compile never parses the index", () => {
    const a = makeInstance();
    a.xhr.routes[TIKZ_URL] = { status: 200, body: TIKZ_U8 };
    a.bm.resolve("tikz.sty", 26);
    a.bm.resolve("nosuchfile.sty", 26);
    const ws = workingsetReply(a, 1 << 30);

    const b = makeInstance();
    b.bm.handle({ cmd: "loadworkingset", resolutions: ws.resolutions, files: ws.files, msgId: 2 });
    const r = b.bm.resolve("tikz.sty", 26);
    assert.strictEqual(r.path, "/texmf/tex/latex/tikz/tikz.sty");
    assert.deepStrictEqual(b.bm.resolve("nosuchfile.sty", 26), { absent: true });
    assert.strictEqual(b.xhr.calls.length, 0);
    assert.strictEqual(b.bm.stats.indexParsed, false);
    assert.strictEqual(b.bm.stats.memoHits, 2);
    assert.strictEqual(b.bm.stats.memoMisses, 0);
});

test("memo exactness: a restored resolution is returned verbatim even if the index ranks differently", () => {
    const index = makeIndex();
    const aaa = "tex/latex/aaa/foo.sty";
    const zzz = "tex/latex/zzz/foo.sty";
    index.bundles["tex/latex/aaa"] = { url: "b/x/aaa.tar", size: 1, sha256: "0", files: 1 };
    index.bundles["tex/latex/zzz"] = { url: "b/x/zzz.tar", size: 1, sha256: "0", files: 1 };
    index.files[aaa] = "tex/latex/aaa";
    index.files[zzz] = "tex/latex/zzz";
    const ranked = resolveName(26, "foo.sty", buildNameIndex(index.files)).path;
    const other = ranked === aaa ? zzz : aaa;

    const tar = BundleMode.writeTar([[other, new Uint8Array(Buffer.from("restored", "utf8"))]]);
    const { bm, fs, xhr } = makeInstance(index);
    bm.handle({ cmd: "loadworkingset", resolutions: [[26, "foo.sty", other], [26, "gone.sty", null], [10, "gone.fmt", null]], files: toBuffer(tar), msgId: 3 });

    const r = bm.resolve("foo.sty", 26);
    assert.strictEqual(r.relpath, other);
    assert.strictEqual(Buffer.from(fs.readFile(r.path)).toString("utf8"), "restored");
    assert.deepStrictEqual(bm.resolve("gone.sty", 26), { absent: true });
    assert.deepStrictEqual(bm.resolve("gone.fmt", 10), { fallthrough: true });
    assert.strictEqual(xhr.calls.length, 0);
    assert.strictEqual(bm.stats.indexParsed, false);
});

test("a memo hit whose file is not written yet still fetches its bundle", () => {
    const { bm, fs, xhr } = makeInstance();
    xhr.routes[TIKZ_URL] = { status: 200, body: TIKZ_U8 };
    bm.handle({
        cmd: "loadworkingset",
        resolutions: [[26, "tikz.sty", "tex/latex/tikz/tikz.sty"]],
        files: toBuffer(BundleMode.writeTar([])),
        msgId: 4
    });
    const r = bm.resolve("tikz.sty", 26);
    assert.strictEqual(r.path, "/texmf/tex/latex/tikz/tikz.sty");
    assert.strictEqual(r.bundle, "tex/latex/tikz");
    assert.strictEqual(xhr.calls.length, 1);
    assert.strictEqual(Buffer.from(fs.readFile(r.path)).toString("utf8"), "tikz sty contents");
    assert.strictEqual(bm.stats.indexParsed, true);
});

test("loadworkingset replies with the member count and does not dirty the memo", () => {
    const tar = BundleMode.writeTar([["tex/latex/tikz/tikz.sty", new Uint8Array(Buffer.from("x", "utf8"))]]);
    const ctx = makeInstance();
    ctx.bm.handle({
        cmd: "loadworkingset",
        resolutions: [[26, "tikz.sty", "tex/latex/tikz/tikz.sty"]],
        files: toBuffer(tar),
        msgId: 5
    });
    assert.deepStrictEqual(lastReply(ctx).message, { result: "ok", cmd: "loadworkingset", msgId: 5, files: 1 });
    ctx.bm.resolve("tikz.sty", 26);
    assert.strictEqual(workingsetReply(ctx, 1 << 30).changed, false);
});

test("working set round trip: export, load into a fresh instance, resolve with no XHR and no parse", () => {
    const a = makeInstance();
    a.xhr.routes[TIKZ_URL] = { status: 200, body: TIKZ_U8 };
    a.bm.resolve("tikz.sty", 26);
    a.bm.resolve("nosuchfile.sty", 26);
    const ws = workingsetReply(a, 1 << 30);
    assert.strictEqual(ws.result, "ok");
    assert.strictEqual(ws.cmd, "workingset");
    assert.strictEqual(ws.msgId, 9);
    assert.strictEqual(ws.changed, true);
    assert.deepStrictEqual(
        ws.resolutions.slice().sort(),
        [[26, "nosuchfile.sty", null], [26, "tikz.sty", "tex/latex/tikz/tikz.sty"]].sort()
    );
    assert.ok(ws.files instanceof ArrayBuffer);
    const sent = lastReply(a);
    assert.deepStrictEqual(sent.transfer, [ws.files]);
    assert.strictEqual(ws.stats.bundleFetches, 1);
    assert.strictEqual(ws.stats.indexParsed, true);

    const b = makeInstance();
    b.bm.handle({ cmd: "loadworkingset", resolutions: ws.resolutions, files: ws.files, msgId: 2 });
    assert.deepStrictEqual(lastReply(b).message, { result: "ok", cmd: "loadworkingset", msgId: 2, files: 1 });
    const r = b.bm.resolve("tikz.sty", 26);
    assert.strictEqual(Buffer.from(b.fs.readFile(r.path)).toString("utf8"), "tikz sty contents");
    assert.deepStrictEqual(b.bm.resolve("nosuchfile.sty", 26), { absent: true });
    assert.strictEqual(b.xhr.calls.length, 0);
    assert.strictEqual(b.bm.stats.indexParsed, false);
    assert.strictEqual(b.bm.stats.bundleFetches, 0);
});

test("the limit falls back to the keys used in this session", () => {
    const a = makeInstance();
    a.xhr.routes[TIKZ_URL] = { status: 200, body: TIKZ_U8 };
    a.xhr.routes[AMSMATH_URL] = { status: 200, body: AMSMATH_U8 };
    a.bm.resolve("amsmath.sty", 26);
    a.bm.resolve("tikz.sty", 26);
    const ws = workingsetReply(a, 1 << 30);

    const b = makeInstance();
    b.xhr.routes[TIKZ_URL] = { status: 200, body: TIKZ_U8 };
    b.bm.handle({ cmd: "loadworkingset", resolutions: ws.resolutions, files: ws.files, msgId: 2 });
    b.bm.resolve("tikz.sty", 26); // memo hit, file already unpacked
    // Make the memo dirty with a fresh miss, then export under a tiny limit.
    b.bm.resolve("nosuchfile.sty", 26);
    const small = workingsetReply(b, 1);
    assert.strictEqual(small.changed, true);
    assert.deepStrictEqual(
        small.resolutions.map((r) => r[1]).sort(),
        ["nosuchfile.sty", "tikz.sty"]
    );
    // amsmath was restored but never used here, so it is not in the small set.
    assert.ok(!small.resolutions.some((r) => r[1] === "amsmath.sty"));
});

test("workingset reports changed:false when clean and after an export", () => {
    const ctx = makeInstance();
    let ws = workingsetReply(ctx, 1 << 30);
    assert.strictEqual(ws.changed, false);
    assert.strictEqual(ws.resolutions, undefined);
    assert.strictEqual(ws.files, undefined);
    assert.strictEqual(typeof ws.stats, "object");

    ctx.bm.resolve("nosuchfile.sty", 26);
    ws = workingsetReply(ctx, 1 << 30);
    assert.strictEqual(ws.changed, true);
    ws = workingsetReply(ctx, 1 << 30);
    assert.strictEqual(ws.changed, false);
});

test("writeTar: long names (over 100 bytes), empty and multi-block members read back by readTar", () => {
    const longPath = "tex/latex/" + "deep/".repeat(30) + "file-with-a-long-name.sty";
    assert.ok(longPath.length > 100);
    const big = new Uint8Array(1300);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const entries = [
        ["short.sty", new Uint8Array(Buffer.from("short", "utf8"))],
        [longPath, big],
        ["empty.sty", new Uint8Array(0)]
    ];
    const tar = BundleMode.writeTar(entries);
    assert.strictEqual(tar.length % 512, 0);
    const seen = [];
    readTar(tar, (name, bytes) => seen.push([name, Buffer.from(bytes)]));
    assert.deepStrictEqual(seen.map((s) => s[0]), entries.map((e) => e[0]));
    entries.forEach((e, i) => assert.ok(Buffer.from(e[1]).equals(seen[i][1])));
});

test("digest mismatch: error result, bundle not unpacked, not memoised", () => {
    const ctx = makeInstance();
    const { bm, fs, xhr } = ctx;
    // Serve AMSMATH bytes under the tikz bundle's URL: size and sha256 will
    // not match the index's recorded values for tex/latex/tikz.
    xhr.routes[TIKZ_URL] = { status: 200, body: AMSMATH_U8 };

    const result = bm.resolve("tikz.sty", 26);
    assert.ok(result.error === "digest-mismatch" || result.error === "size-mismatch");
    assert.strictEqual(result.bundle, "tex/latex/tikz");
    assert.ok(!bm.loaded.has("tex/latex/tikz"));
    assert.throws(() => fs.readFile("/texmf/tex/latex/tikz/tikz.sty"));
    assert.strictEqual(workingsetReply(ctx, 1 << 30).changed, false);
});

test("same-size wrong bytes give digest-mismatch", () => {
    const { bm, xhr } = makeInstance();
    const wrong = new Uint8Array(TIKZ_U8.length);
    wrong.fill(7);
    xhr.routes[TIKZ_URL] = { status: 200, body: wrong };
    assert.deepStrictEqual(bm.resolve("tikz.sty", 26), { error: "digest-mismatch", bundle: "tex/latex/tikz" });
});

test("wrong size gives size-mismatch", () => {
    const { bm, xhr } = makeInstance();
    xhr.routes[TIKZ_URL] = { status: 200, body: new Uint8Array(3) };
    assert.deepStrictEqual(bm.resolve("tikz.sty", 26), { error: "size-mismatch", bundle: "tex/latex/tikz" });
});

test("transport error is not memoised: a later resolve retries the fetch", () => {
    const ctx = makeInstance();
    const { bm, xhr } = ctx;
    xhr.routes[TIKZ_URL] = { throwErr: true };

    const first = bm.resolve("tikz.sty", 26);
    assert.deepStrictEqual(first, { error: "transport-error", bundle: "tex/latex/tikz" });
    assert.ok(!bm.loaded.has("tex/latex/tikz"));
    assert.strictEqual(workingsetReply(ctx, 1 << 30).changed, false);

    xhr.routes[TIKZ_URL] = { status: 200, body: TIKZ_U8 };
    const second = bm.resolve("tikz.sty", 26);
    assert.strictEqual(second.path, "/texmf/tex/latex/tikz/tikz.sty");
    assert.strictEqual(xhr.calls.length, 2);
    assert.strictEqual(workingsetReply(ctx, 1 << 30).changed, true);
});

test("format-10 hit is copied into the work directory", () => {
    const index = makeIndex();
    index.files["tex/latex/tikz/pdflatex.fmt"] = "tex/latex/tikz";
    const tar = BundleMode.writeTar([["tex/latex/tikz/pdflatex.fmt", new Uint8Array(Buffer.from("fmt", "utf8"))]]);
    const { bm, fs } = makeInstance(index);
    bm.handle({
        cmd: "loadworkingset",
        resolutions: [[10, "pdflatex.fmt", "tex/latex/tikz/pdflatex.fmt"]],
        files: toBuffer(tar),
        msgId: 6
    });
    const r = bm.resolve("pdflatex.fmt", 10);
    assert.strictEqual(r.path, "/texmf/tex/latex/tikz/pdflatex.fmt");
    assert.strictEqual(Buffer.from(fs.readFile("/work/pdflatex.fmt")).toString("utf8"), "fmt");
});

test("handle returns false for unknown commands and posts nothing", () => {
    const ctx = makeInstance();
    const before = ctx.messages.length;
    assert.strictEqual(ctx.bm.handle({ cmd: "compile", msgId: 1 }), false);
    assert.strictEqual(ctx.bm.handle({ cmd: "preloadbundle", msgId: 2 }), false);
    assert.strictEqual(ctx.messages.length, before);
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
