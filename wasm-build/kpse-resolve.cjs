// Pure kpathsea-name resolution helpers, shared by the WASM worker and unit
// tests. Loaded by pdftex-worker.js before the generated Emscripten module, so
// these become globals the controller can call; the CommonJS export at the bottom (a
// no-op in the worker, where `module` is undefined) lets tests require them.
//
// Why this exists: the CDN bucket and its bloom filter are keyed by the file's
// stored name, but kpathsea looks files up under names that differ by extension
// (it requests virtual fonts as "ptmb7t.vf" where the bucket stores "ptmb7t",
// and \input/source files bare as "xkeyval" where the bucket stores
// "xkeyval.tex"). The worker must reconcile those namespaces.
//
// Bundle mode (see SPEC-latex.md, "Package delivery: bundles, not files") adds
// three more pieces of shared logic: FORMAT_SEARCH_ORDER (moved here from
// tools/build-format.mjs so the format build and the runtime resolver rank
// candidate paths identically), buildNameIndex/rankPaths/resolveName (turning
// the index's flat "files" map into a resolver over ranked paths), and
// sha256Hex/readTar (verifying and unpacking a bundle without a browser crypto
// API, since kpathsea's callback into JS is synchronous and crypto.subtle is
// not). sha256Hex runs a small synchronous wasm module.

// Extensions the XHR fallback appends for a given kpathsea format id.
function retryExtensions(format) {
    if (format === 26) return [".tex", ".sty", ".cls", ".def", ".cfg", ".ltx"];
    if (format === 3) return [".tfm"];
    if (format === 33) return [".vf"];
    if (format === 7) return [".bst"];
    if (format === 47) return [".otf"];
    if (format === 36) return [".ttf", ".ttc"];
    if (format === 32) return [".pfb"];
    return [];
}

// Every bucket key the fallback could end up fetching for a request, i.e. the
// names the bloom filter must be checked against before skipping the XHR: the
// exact request, the extension-stripped form, and each appended format
// extension. If none of these is in the bloom the file is genuinely absent.
function bloomCandidates(format, reqname) {
    var keys = [format + "/" + reqname];
    if (reqname.indexOf(".") >= 0) {
        keys.push(format + "/" + reqname.substring(0, reqname.lastIndexOf(".")));
    }
    var exts = retryExtensions(format);
    for (var i = 0; i < exts.length; i++) {
        if (!reqname.endsWith(exts[i])) {
            keys.push(format + "/" + reqname + exts[i]);
        }
    }
    return keys;
}

// The bucket names the fallback should actually fetch, in order, for a
// request: the exact name, the extension-stripped form, then each appended
// format extension — but only those the bloom filter does not rule out. Without
// a bloom filter (`mayExist` is null) every candidate is kept, as before.
//
// Why per-candidate filtering matters: kpathsea asks for "ptmb7t.vf" while the
// bucket stores "33/ptmb7t", so fetching the exact name first was one guaranteed
// 404 per virtual or metric font; and a genuinely missing config file used to
// cost up to seven 404s (the name, the stripped name, and every extension) as
// soon as any one of those keys collided with the bloom filter. Each 404 is a
// full origin round trip when the edge has not cached it yet.
function fetchCandidates(format, reqname, mayExist) {
    var names = [reqname];
    if (reqname.indexOf(".") >= 0) {
        names.push(reqname.substring(0, reqname.lastIndexOf(".")));
    }
    var exts = retryExtensions(format);
    for (var i = 0; i < exts.length; i++) {
        if (!reqname.endsWith(exts[i])) names.push(reqname + exts[i]);
    }
    if (typeof mayExist !== "function") return names;
    var kept = [];
    for (var j = 0; j < names.length; j++) {
        if (mayExist(format + "/" + names[j])) kept.push(names[j]);
    }
    return kept;
}

// --- Format search order, shared by the format build and the runtime resolver -
//
// The engine asks for a file as (format id, bare name). A real texmf tree holds
// several files per name and kpathsea picks between them by search path, so the
// resolver has to as well. Getting this wrong is quiet: the build still
// succeeds, it is just built from the wrong latex.ltx.
//
// Each entry lists path prefixes in kpathsea preference order, mirroring the
// TEXINPUTS-style paths pdflatex runs with, e.g.
//   TEXINPUTS = .;$TEXMF/tex/{latex,generic,}//
// which is why tex/latex/base/latex.ltx beats tex/latex-dev/base/latex.ltx, and
// babel's hyphen.cfg beats cslatex's. A file outside every listed prefix is not
// that format's file and is not offered to the engine.
var FORMAT_SEARCH_ORDER = {
    3: ['fonts/tfm/'],                            // TFM metrics
    4: ['fonts/afm/'],                            // AFM metrics
    6: ['bibtex/bib/'],                           // .bib
    7: ['bibtex/bst/'],                           // .bst
    11: ['fonts/map/'],                           // font maps
    26: ['tex/latex/', 'tex/generic/', 'tex/'],     // .tex .sty .cls .def .cfg .ltx .ini
    28: ['web2c/'],                               // pool files
    32: ['fonts/type1/'],                         // .pfb
    33: ['fonts/vf/'],                            // virtual fonts
    36: ['fonts/truetype/'],
    44: ['fonts/enc/'],                           // encodings
    47: ['fonts/opentype/'],
    48: ['tex/generic/config/', 'web2c/'],        // pdftex.cfg
    51: ['tex/luatex/', 'tex/generic/', 'scripts/'], // .lua
};

// --- Bundle-index resolution ---------------------------------------------------
//
// The index's "files" map is texmf-relative-path -> bundle name, one entry per
// path. buildNameIndex inverts that into basename -> [paths...] once at load,
// so resolveName can do what the per-file harness's `index` (built by walking
// the texmf tree) already did: look up every path with a given basename, rank
// them, and take the winner.

// basename(path) without pulling in node's `path` module, so this also runs in
// the worker.
function baseName(p) {
    var slash = p.lastIndexOf("/");
    return slash < 0 ? p : p.substring(slash + 1);
}

// files: the index's {"tex/latex/amsmath/amsmath.sty": "core", ...} map.
// Returns a Map from basename to an array of texmf-relative paths.
function buildNameIndex(files) {
    var byName = new Map();
    for (var relpath in files) {
        if (!Object.prototype.hasOwnProperty.call(files, relpath)) continue;
        var name = baseName(relpath);
        var list = byName.get(name);
        if (list) list.push(relpath);
        else byName.set(name, [relpath]);
    }
    return byName;
}

// Rank paths by the same rule the format build uses: position of the first
// matching prefix in FORMAT_SEARCH_ORDER[format] (paths matching no prefix are
// dropped), then by depth (fewer path segments first), then by string compare,
// so the answer never depends on iteration order. An unknown format id keeps
// every path at rank 0 (no prefix knowledge to filter with).
function rankPaths(format, paths) {
    var order = FORMAT_SEARCH_ORDER[format];
    var ranked = [];
    for (var i = 0; i < paths.length; i++) {
        var p = paths[i];
        var rank = 0;
        if (order) {
            rank = -1;
            for (var j = 0; j < order.length; j++) {
                if (p.indexOf(order[j]) === 0) { rank = j; break; }
            }
            if (rank < 0) continue;
        }
        ranked.push({ path: p, rank: rank, depth: p.split("/").length });
    }
    ranked.sort(function(a, b) {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (a.depth !== b.depth) return a.depth - b.depth;
        return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0);
    });
    var out = [];
    for (var k = 0; k < ranked.length; k++) out.push(ranked[k].path);
    return out;
}

// The bundle-mode replacement for fetchCandidates: apply the same
// candidate-name logic (exact, extension-stripped, appended retryExtensions)
// in order, and return the first candidate whose ranked paths are non-empty.
// nameIndex is the Map from buildNameIndex. Returns { candidate, path } or
// null if no candidate name resolves to anything.
function resolveName(format, reqname, nameIndex) {
    var names = [reqname];
    if (reqname.indexOf(".") >= 0) {
        names.push(reqname.substring(0, reqname.lastIndexOf(".")));
    }
    var exts = retryExtensions(format);
    for (var i = 0; i < exts.length; i++) {
        if (!reqname.endsWith(exts[i])) names.push(reqname + exts[i]);
    }
    for (var n = 0; n < names.length; n++) {
        var paths = nameIndex.get(names[n]);
        if (!paths || !paths.length) continue;
        var ranked = rankPaths(format, paths);
        if (ranked.length) return { candidate: names[n], path: ranked[0] };
    }
    return null;
}

// --- SHA-256 --------------------------------------------------------------
//
// A small wasm module (wasm-build/sha256, rebuilt by tools/build-sha256.mjs),
// compiled and instantiated synchronously on first use. The embedded base64
// sits between the markers below; do not edit it by hand.

// BEGIN GENERATED SHA256 WASM
var SHA256_WASM_BASE64 = "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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGfmCWqFrme7cvNuPDr1T6V/Ug5RjGgFm6vZgx8ZzeBbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIgCBG5hbWUAERBzaGEyNTZfd2FzbS53YXNtAcYBCAAoX1JOdkNzY1dVcWI0RkpFdlJfMTFzaGEyNTZfd2FzbThjb21wcmVzcwEGZmluaXNoAjlfUk52TnROdENzNW9CVlplRkVXem1fNGNvcmU1c2xpY2U1aW5kZXgxNnNsaWNlX2luZGV4X2ZhaWwDBGluaXQEDmlucHV0X2NhcGFjaXR5BQlpbnB1dF9wdHIGBnVwZGF0ZQctX1JOdk50Q3M1b0JWWmVGRVd6bV80Y29yZTlwYW5pY2tpbmc5cGFuaWNfZm10BxIBAA9fX3N0YWNrX3BvaW50ZXIJEQIABy5yb2RhdGEBBS5kYXRhAFUJcHJvZHVjZXJzAghsYW5ndWFnZQEEUnVzdAAMcHJvY2Vzc2VkLWJ5AQVydXN0YyUxLjk5LjAtbmlnaHRseSAoMTExNzdmMjIzIDIwMjYtMDgtMDIpAJQBD3RhcmdldF9mZWF0dXJlcwgrC2J1bGstbWVtb3J5Kw9idWxrLW1lbW9yeS1vcHQrFmNhbGwtaW5kaXJlY3Qtb3ZlcmxvbmcrCm11bHRpdmFsdWUrD211dGFibGUtZ2xvYmFscysTbm9udHJhcHBpbmctZnB0b2ludCsPcmVmZXJlbmNlLXR5cGVzKwhzaWduLWV4dA==";
// END GENERATED SHA256 WASM

var sha256Instance = null;

function sha256Exports() {
    if (sha256Instance) return sha256Instance;
    if (!SHA256_WASM_BASE64) {
        throw new Error("sha256: embedded wasm module is empty; run node tools/build-sha256.mjs");
    }
    var bin = atob(SHA256_WASM_BASE64);
    var wasmBytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) wasmBytes[i] = bin.charCodeAt(i);
    var module = new WebAssembly.Module(wasmBytes);
    sha256Instance = new WebAssembly.Instance(module, {}).exports;
    return sha256Instance;
}

// bytes: a Uint8Array. Returns the 64-hex-char digest.
function sha256Hex(bytes) {
    var ex = sha256Exports();
    var cap = ex.input_capacity();
    ex.init();
    for (var off = 0; off < bytes.length; off += cap) {
        var n = Math.min(cap, bytes.length - off);
        // Re-read the memory each chunk: it is the same buffer unless the
        // module grows, but this keeps the view valid either way.
        new Uint8Array(ex.memory.buffer, ex.input_ptr(), n).set(bytes.subarray(off, off + n));
        ex.update(n);
    }
    var digest = new Uint8Array(ex.memory.buffer, ex.finish(), 32);
    var hex = "";
    for (var j = 0; j < 32; j++) {
        hex += (digest[j] < 16 ? "0" : "") + digest[j].toString(16);
    }
    return hex;
}

// --- Tar reader -------------------------------------------------------------
//
// A bundle is an uncompressed ustar tar with regular files only (typeflag
// '0'), sorted by path, GNU long-name entries (typeflag 'L', name
// "././@LongLink") preceding members whose path is 100 bytes or more (the
// ustar prefix field is never used), and two zero blocks at the end.

function tarString(block, offset, len) {
    var end = offset;
    var stop = offset + len;
    while (end < stop && block[end] !== 0) end++;
    var s = "";
    for (var i = offset; i < end; i++) s += String.fromCharCode(block[i]);
    return s;
}

function tarOctal(block, offset, len) {
    var s = tarString(block, offset, len).trim();
    return s.length ? parseInt(s, 8) : 0;
}

function isZeroBlock(bytes, offset) {
    for (var i = 0; i < 512; i++) {
        if (bytes[offset + i] !== 0) return false;
    }
    return true;
}

// bytes: a Uint8Array of the whole tar. onEntry(path, bytesSubarray) is called
// once per regular file member, in the order they appear (which is sorted
// path order, per the bundle contract).
function readTar(bytes, onEntry) {
    var offset = 0;
    var pendingLongName = null;
    while (offset + 512 <= bytes.length) {
        if (isZeroBlock(bytes, offset)) break; // end-of-archive marker
        var typeflag = String.fromCharCode(bytes[offset + 156]);
        var size = tarOctal(bytes, offset + 124, 12);
        var name;
        if (typeflag === "L") {
            // GNU long-name entry: its data is the real name of the *next*
            // member, NUL-terminated, padded to a 512-byte boundary.
            var dataStart = offset + 512;
            pendingLongName = tarString(bytes, dataStart, size);
            offset = dataStart + Math.ceil(size / 512) * 512;
            continue;
        }
        name = pendingLongName !== null ? pendingLongName : tarString(bytes, offset, 100);
        pendingLongName = null;
        var dataOffset = offset + 512;
        if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
            onEntry(name, bytes.subarray(dataOffset, dataOffset + size));
        }
        offset = dataOffset + Math.ceil(size / 512) * 512;
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        retryExtensions, bloomCandidates, fetchCandidates,
        FORMAT_SEARCH_ORDER,
        buildNameIndex, rankPaths, resolveName,
        sha256Hex, readTar,
    };
}
