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
// not).

// Extensions the XHR fallback appends for a given kpathsea format id.
function retryExtensions(format) {
    if (format === 26) return [".tex", ".sty", ".cls", ".def", ".cfg", ".ltx"];
    if (format === 3) return [".tfm"];
    if (format === 33) return [".vf"];
    if (format === 7) return [".bst"];
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
// Synchronous, pure JS. kpathsea's callback into JS is synchronous (the engine
// is not re-entrant), so crypto.subtle — Promise-based everywhere it exists —
// cannot be used to verify a bundle before unpacking it.

var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

// bytes: a Uint8Array. Returns the 64-hex-char digest.
function sha256Hex(bytes) {
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    var bitLenLow = (bytes.length << 3) >>> 0;
    // bytes.length can exceed 2^29 (a bundle can be tens of MB), so the high
    // 32 bits of the 64-bit bit-length must come from the part that
    // `<< 3` on a 32-bit int would otherwise drop.
    var bitLenHigh = Math.floor(bytes.length / 0x20000000);

    var padLen = ((bytes.length + 9 + 63) & ~63);
    var msg = new Uint8Array(padLen);
    msg.set(bytes);
    msg[bytes.length] = 0x80;
    msg[padLen - 8] = (bitLenHigh >>> 24) & 0xff;
    msg[padLen - 7] = (bitLenHigh >>> 16) & 0xff;
    msg[padLen - 6] = (bitLenHigh >>> 8) & 0xff;
    msg[padLen - 5] = bitLenHigh & 0xff;
    msg[padLen - 4] = (bitLenLow >>> 24) & 0xff;
    msg[padLen - 3] = (bitLenLow >>> 16) & 0xff;
    msg[padLen - 2] = (bitLenLow >>> 8) & 0xff;
    msg[padLen - 1] = bitLenLow & 0xff;

    var w = new Int32Array(64);
    for (var offset = 0; offset < padLen; offset += 64) {
        for (var t = 0; t < 16; t++) {
            var i = offset + t * 4;
            w[t] = (msg[i] << 24) | (msg[i + 1] << 16) | (msg[i + 2] << 8) | msg[i + 3];
        }
        for (t = 16; t < 64; t++) {
            var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
            var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
            w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
        }

        var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
        for (t = 0; t < 64; t++) {
            var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            var ch = (e & f) ^ (~e & g);
            var temp1 = (hh + S1 + ch + SHA256_K[t] + w[t]) | 0;
            var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            var maj = (a & b) ^ (a & c) ^ (b & c);
            var temp2 = (S0 + maj) | 0;
            hh = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0;
    }

    var out = [h0, h1, h2, h3, h4, h5, h6, h7];
    var hex = "";
    for (var oi = 0; oi < out.length; oi++) {
        hex += (out[oi] >>> 0).toString(16).replace(/^(.{0,7})$/, function(m) {
            return "00000000".substring(m.length) + m;
        });
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
