// Plain node:assert tests for kpse-resolve.cjs. Run with:
//   node wasm-build/kpse-resolve.test.cjs
"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const {
    rankPaths,
    resolveName,
    buildNameIndex,
    sha256Hex,
    readTar,
} = require("./kpse-resolve.cjs");

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log("ok - " + name);
}

// --- rankPaths ---------------------------------------------------------------

test("rankPaths prefers tex/latex/base over tex/latex-dev/base", () => {
    const paths = [
        "tex/latex-dev/base/latex.ltx",
        "tex/latex/base/latex.ltx",
    ];
    const ranked = rankPaths(26, paths);
    assert.strictEqual(ranked[0], "tex/latex/base/latex.ltx");
});

test("rankPaths prefers babel's hyphen.cfg over cslatex's", () => {
    const paths = [
        "tex/generic/cslatex/hyphen.cfg",
        "tex/generic/babel/hyphen.cfg",
    ];
    const ranked = rankPaths(26, paths);
    assert.strictEqual(ranked[0], "tex/generic/babel/hyphen.cfg");
});

test("rankPaths for format 3 (tfm) drops non-tfm paths", () => {
    const paths = [
        "fonts/vf/public/cm/cmr10.vf",
        "fonts/tfm/public/cm/cmr10.tfm",
    ];
    const ranked = rankPaths(3, paths);
    assert.deepStrictEqual(ranked, ["fonts/tfm/public/cm/cmr10.tfm"]);
});

test("rankPaths keeps everything at rank 0 for an unknown format id", () => {
    const paths = ["a/b/c", "a/b"];
    const ranked = rankPaths(9999, paths);
    // No prefix filtering; falls back to depth then string compare.
    assert.deepStrictEqual(ranked, ["a/b", "a/b/c"]);
});

// --- resolveName ---------------------------------------------------------------

function makeIndex(files) {
    return buildNameIndex(files);
}

test("resolveName finds ptmb7t.vf via a path ending /ptmb7t.vf", () => {
    const idx = makeIndex({
        "fonts/vf/public/urw/ptmb7t.vf": "fonts/public/urw",
        "fonts/tfm/public/urw/ptmb7t.tfm": "fonts/public/urw",
    });
    const hit = resolveName(33, "ptmb7t.vf", idx);
    assert.ok(hit, "expected a hit");
    assert.ok(hit.path.endsWith("/ptmb7t.vf"), hit.path);
});

test("resolveName finds bare xkeyval by appending .tex", () => {
    const idx = makeIndex({
        "tex/latex/xkeyval/xkeyval.sty": "tex/latex/xkeyval",
        "tex/generic/xkeyval/xkeyval.tex": "tex/latex/xkeyval",
    });
    // format 26 tries .tex, .sty, .cls, .def, .cfg, .ltx in that order; xkeyval.tex
    // exists in tex/generic which is ranked ahead of tex/ (base prefix) — but here
    // both .tex and .sty candidate names exist, .tex being tried first per
    // retryExtensions order, so we expect the .tex file to win.
    const hit = resolveName(26, "xkeyval", idx);
    assert.ok(hit, "expected a hit");
    assert.strictEqual(hit.candidate, "xkeyval.tex");
    assert.strictEqual(hit.path, "tex/generic/xkeyval/xkeyval.tex");
});

test("resolveName strips extensions to widen the search too", () => {
    const idx = makeIndex({
        "tex/latex/foo/foo.sty": "tex/latex/foo",
    });
    // A request for "foo.cls" (no direct hit) strips to "foo" (no hit either,
    // nothing named exactly "foo"), so this should fail cleanly.
    const hit = resolveName(26, "foo.cls", idx);
    assert.strictEqual(hit, null);
});

test("resolveName returns null when nothing matches", () => {
    const idx = makeIndex({ "tex/latex/foo/foo.sty": "tex/latex/foo" });
    assert.strictEqual(resolveName(26, "doesnotexist", idx), null);
});

// --- sha256Hex -----------------------------------------------------------------

function nodeSha256(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

test("sha256Hex matches node:crypto on various sizes", () => {
    const sizes = [0, 1, 55, 56, 64, 65, 1024 * 1024];
    for (const size of sizes) {
        const buf = Buffer.alloc(size);
        for (let i = 0; i < size; i++) buf[i] = (i * 7 + 3) & 0xff;
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        assert.strictEqual(sha256Hex(u8), nodeSha256(buf), "size " + size);
    }
});

// --- readTar --------------------------------------------------------------------

// A tiny ustar writer, following the contract in SPEC-latex.md: regular files
// only (typeflag '0'), sorted by path, GNU long-name ('L', name
// "././@LongLink") entries preceding members whose path is >= 100 bytes, two
// zero blocks at the end, ustar prefix field never used.
function padBlock(buf) {
    const rem = buf.length % 512;
    if (rem === 0) return buf;
    return Buffer.concat([buf, Buffer.alloc(512 - rem)]);
}

function octalField(value, len) {
    // Standard tar octal field: digits, NUL, padded with leading zeros. Field
    // width `len` includes the trailing NUL.
    const s = value.toString(8);
    const padded = "0".repeat(Math.max(0, len - 1 - s.length)) + s + "\0";
    return Buffer.from(padded, "ascii");
}

function checksumHeader(header) {
    // Checksum field (offset 148, 8 bytes) is computed with that field taken
    // as all spaces.
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < copy.length; i++) sum += copy[i];
    const field = octalField(sum, 7);
    header.set(field, 148);
    header[155] = 0x20;
}

function makeHeader(name, size, typeflag) {
    const header = Buffer.alloc(512);
    header.write(name.slice(0, 100), 0, "ascii");
    header.write("0000644\0", 100, "ascii"); // mode
    header.set(octalField(0, 8), 108); // uid
    header.set(octalField(0, 8), 116); // gid
    header.set(octalField(size, 12), 124); // size
    header.set(octalField(0, 12), 136); // mtime
    header.write(typeflag, 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    checksumHeader(header);
    return header;
}

function makeLongNameEntry(name) {
    const nameBuf = Buffer.from(name + "\0", "utf8");
    const header = makeHeader("././@LongLink", nameBuf.length, "L");
    return Buffer.concat([header, padBlock(nameBuf)]);
}

function makeFileEntry(name, data) {
    const buf = Buffer.from(data, "utf8");
    const chunks = [];
    if (Buffer.byteLength(name, "utf8") >= 100) {
        chunks.push(makeLongNameEntry(name));
        chunks.push(makeHeader(name.slice(0, 100), buf.length, "0"));
    } else {
        chunks.push(makeHeader(name, buf.length, "0"));
    }
    chunks.push(padBlock(buf));
    return Buffer.concat(chunks);
}

function buildTar(members) {
    const chunks = members
        .slice()
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((m) => makeFileEntry(m.name, m.data));
    chunks.push(Buffer.alloc(1024)); // two zero blocks
    return Buffer.concat(chunks);
}

test("readTar round-trips a tar with a short and a long (>=100 byte) path", () => {
    const longName = "tex/latex/" + "a".repeat(90) + "/deep.sty"; // >= 100 bytes
    assert.ok(Buffer.byteLength(longName, "utf8") >= 100);
    const members = [
        { name: "tex/latex/amsmath/amsmath.sty", data: "amsmath contents" },
        { name: longName, data: "deep contents" },
    ];
    const tar = buildTar(members);
    const u8 = new Uint8Array(tar.buffer, tar.byteOffset, tar.byteLength);

    const seen = [];
    readTar(u8, (path, bytes) => {
        seen.push({ path: path, text: Buffer.from(bytes).toString("utf8") });
    });

    assert.strictEqual(seen.length, 2);
    const byPath = Object.fromEntries(seen.map((s) => [s.path, s.text]));
    assert.strictEqual(byPath["tex/latex/amsmath/amsmath.sty"], "amsmath contents");
    assert.strictEqual(byPath[longName], "deep contents");
});

test("readTar yields members in sorted order and ignores nothing but non-regular types", () => {
    const tar = buildTar([
        { name: "b.tex", data: "B" },
        { name: "a.tex", data: "A" },
    ]);
    const u8 = new Uint8Array(tar.buffer, tar.byteOffset, tar.byteLength);
    const order = [];
    readTar(u8, (path) => order.push(path));
    assert.deepStrictEqual(order, ["a.tex", "b.tex"]);
});

console.log(passed + " tests passed");
