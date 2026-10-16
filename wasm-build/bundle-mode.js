// =============================================================================
// bundle-mode.js: bundle-mode resolver shared by every authored engine worker
// =============================================================================
//
// SPEC-latex.md, "Package delivery: bundles, not files" and "The resolver".
// This used to be duplicated (badly, only pdftex-worker.js had it) as
// writeBundleMember/unpackBundle/fetchAndUnpackBundle/resolveViaBundleIndex
// plus the loadbundleindex message handler. It now lives once, parameterized
// by an `env` object so every worker (pdftex, xetex, luatex, dvipdfm, bibtex,
// bibtex8, makeindex, latexml) can plug in its own Emscripten FS, its own
// texlive_endpoint accessor and its own resolver-evidence sink.
//
// Working sets. TeX opens a few megabytes of an 89 MB package tree. Each
// engine remembers the exact answers its resolver gave (the memo, keyed
// "<format>/<reqname>", valued with a texmf-relative path or null for "the
// index has no entry") and the files those answers point at. The host stores
// that pair per release and sends it back on the next start in a
// `loadworkingset` message. A restored engine unpacks the files, installs the
// memo and answers from it verbatim. No bundle is fetched, hashed or even
// listed again unless a request misses.
//
// Lazy index. `loadbundleindex` only stores the bytes of bundles.json. The
// 14.5 MB JSON is parsed, and the name index built, on the first memo miss
// (or the first memo hit whose file is not written yet and so needs its
// bundle name). A compile that is answered entirely from the working set
// never parses it.
//
// No Cache Storage. The engine never touches it. Persistence belongs to the
// host, which asks for the working set with a `workingset` message after a
// compile and stores the reply.
//
// Loaded by importScripts('bundle-mode.js') after
// kpse-resolve.js (it uses resolveName/buildNameIndex/sha256Hex/
// readTar from there) and before the generated Emscripten module. The
// CommonJS export at the bottom is a no-op in the worker (where `module` is
// undefined) and lets wasm-build/bundle-mode.test.cjs require() it.
//
// env shape:
//   FS           : the Emscripten FS object (mkdirTree, writeFile, readFile)
//   texmfRoot    : e.g. "/texmf"; bundle members unpack under here
//   workRoot     : optional, e.g. "/work"; format-10 hits are also copied
//                   here, matching open_fmt_file()'s fopen() of the working
//                   directory (see pdftex-worker.js's old resolveViaBundleIndex)
//   endpoint()   : returns the current texlive_endpoint string
//   postMessage  : (message, transfer) for "downloading" progress messages
//                   and message replies; `transfer` is an optional list of
//                   transferable objects and is only passed with the
//                   `workingset` reply
//   evidence(reqname, format, outcome, attempts): resolver evidence sink;
//                   may be a no-op for workers that don't wire one up
//   xhrTimeout   : optional, defaults to 150000ms
//
// Messages handled by handle(data); every reply carries cmd and msgId:
//   loadbundleindex  { data: ArrayBuffer }                      -> { result: "ok" }
//   loadworkingset   { resolutions: [[format, reqname, relpath|null], ...],
//                      files: ArrayBuffer (tar) }               -> { result: "ok", files: n }
//                                                                  or { result: "failed", log }
//   workingset       { limit: bytes }                           -> { result: "ok", changed, stats }
//                    and, when changed, { resolutions, files: ArrayBuffer (tar, transferred) }

var BundleMode = (function() {

    function now() {
        return (typeof performance !== "undefined" && performance && typeof performance.now === "function")
            ? performance.now()
           : Date.now();
    }

    function asciiBytes(s) {
        var out = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
        return out;
    }

    function octalField(value, len) {
        var s = value.toString(8);
        while (s.length < len - 1) s = "0" + s;
        return s + "\0";
    }

    function putString(block, offset, s) {
        for (var i = 0; i < s.length; i++) block[offset + i] = s.charCodeAt(i) & 0xff;
    }

    // One 512-byte ustar header. `name` is already at most 100 bytes.
    function tarHeader(name, size, typeflag) {
        var header = new Uint8Array(512);
        putString(header, 0, name);
        putString(header, 100, "0000644\0");
        putString(header, 108, octalField(0, 8));
        putString(header, 116, octalField(0, 8));
        putString(header, 124, octalField(size, 12));
        putString(header, 136, octalField(0, 12));
        putString(header, 148, "        ");
        putString(header, 156, typeflag);
        putString(header, 257, "ustar\0");
        putString(header, 263, "00");
        var sum = 0;
        for (var i = 0; i < 512; i++) sum += header[i];
        putString(header, 148, octalField(sum, 7));
        header[155] = 0x20;
        return header;
    }

    // Write a ustar archive of [path, Uint8Array] entries. A path longer
    // than 100 bytes gets a GNU "L" entry (the real name, NUL-terminated)
    // ahead of its member, which is what readTar() reads back.
    function writeTar(entries) {
        var chunks = [];
        var total = 0;
        function push(chunk) { chunks.push(chunk); total += chunk.length; }
        function padded(data) {
            var len = Math.ceil(data.length / 512) * 512;
            if (len === data.length) return data;
            var out = new Uint8Array(len);
            out.set(data);
            return out;
        }
        for (var i = 0; i < entries.length; i++) {
            var path = entries[i][0];
            var data = entries[i][1];
            var nameBytes = asciiBytes(path);
            var shortName = path;
            if (nameBytes.length > 100) {
                var longData = new Uint8Array(nameBytes.length + 1);
                longData.set(nameBytes);
                push(tarHeader("././@LongLink", longData.length, "L"));
                push(padded(longData));
                shortName = path.substring(0, 100);
            }
            push(tarHeader(shortName, data.length, "0"));
            if (data.length > 0) push(padded(data));
        }
        push(new Uint8Array(1024));
        var out = new Uint8Array(total);
        var at = 0;
        for (var j = 0; j < chunks.length; j++) {
            out.set(chunks[j], at);
            at += chunks[j].length;
        }
        return out;
    }

    function create(env) {
        // env.FS is not captured into a local here: it is the Emscripten
        // runtime's FS global, which does not exist yet when the worker
        // creates its BundleMode instance (importScripts('bundle-mode.js')
        // runs before importScripts of the generated engine module). Every
        // access below goes through env.FS at call time instead, by which
        // point the engine has finished loading.
        var texmfRoot = env.texmfRoot;
        var workRoot = env.workRoot || null;
        var xhrTimeout = env.xhrTimeout || 150000;

        function evidence(reqname, format, outcome, attempts) {
            if (typeof env.evidence === "function") env.evidence(reqname, format, outcome, attempts);
        }

        var state = {
            indexBytes: null,      // Uint8Array of bundles.json, not yet parsed
            index: null,           // parsed bundles.json (lazy)
            nameIndex: null,       // Map: basename -> [texmf-relative path, ...]
            loaded: new Set(),     // bundle names already unpacked into texmfRoot
            pathsLoaded: new Set(),// texmf-relative paths already written
            memo: new Map(),       // "<format>/<reqname>" -> relpath | null
            sessionKeys: new Set(),// every memo key used in this engine's lifetime
            dirty: false           // memo gained entries since the last export
        };

        var stats = {
            indexParsed: false,
            indexParseMs: 0,
            memoHits: 0,
            memoMisses: 0,
            bundleFetches: 0,
            bundleFetchMs: 0,
            hashMs: 0
        };

        function timedHash(bytes) {
            var t0 = now();
            var digest = sha256Hex(bytes);
            stats.hashMs += now() - t0;
            return digest;
        }

        // Parse the stored index bytes and build the name index, once.
        function ensureIndex() {
            if (state.index) return;
            var t0 = now();
            var text = new TextDecoder("utf-8").decode(state.indexBytes);
            var parsed = JSON.parse(text);
            state.nameIndex = buildNameIndex(parsed["files"] || {});
            state.index = parsed;
            stats.indexParsed = true;
            stats.indexParseMs += now() - t0;
        }

        // Write one bundle member into the virtual filesystem, creating parent
        // directories as needed. Members are written once; a path already
        // unpacked (from this bundle or a duplicate listing) is left alone.
        function writeBundleMember(relpath, memberBytes) {
            if (state.pathsLoaded.has(relpath)) return;
            var fsPath = texmfRoot + "/" + relpath;
            var slash = fsPath.lastIndexOf("/");
            env.FS.mkdirTree(fsPath.substring(0, slash));
            env.FS.writeFile(fsPath, memberBytes);
            state.pathsLoaded.add(relpath);
        }

        // Unpack every member of a verified bundle's tar bytes. A bundle
        // already unpacked this session is never re-unpacked.
        function unpackBundle(name, bytes) {
            if (state.loaded.has(name)) return;
            readTar(bytes, writeBundleMember);
            state.loaded.add(name);
        }

        // Fetch one bundle by synchronous XHR, verify it against the index's
        // sha256, and unpack it. Returns "ok", "transport-error" (network
        // failure or non-200; it never poisons a 404 cache, since the file may
        // well exist; only the transport failed), "size-mismatch" or
        // "digest-mismatch".
        function fetchAndUnpackBundle(name, meta, reqname, format) {
            if (typeof env.postMessage === "function") {
                env.postMessage({ "cmd": "downloading", "file": reqname, "bundle": name, "size": meta.size });
            }
            var t0 = now();
            stats.bundleFetches++;
            try {
                var url = env.endpoint() + meta.url;
                var xhr = new XMLHttpRequest();
                xhr.open("GET", url, false);
                xhr.timeout = xhrTimeout;
                xhr.responseType = "arraybuffer";
                try {
                    xhr.send();
                } catch (err) {
                    return "transport-error";
                }
                if (xhr.status !== 200) return "transport-error";
                var bytes = new Uint8Array(xhr.response);
                if (bytes.length !== meta.size) return "size-mismatch";
                if (timedHash(bytes) !== meta.sha256) return "digest-mismatch";
                unpackBundle(name, bytes);
                return "ok";
            } finally {
                stats.bundleFetchMs += now() - t0;
            }
        }

        function remember(key, relpath) {
            state.memo.set(key, relpath);
            state.dirty = true;
        }

        // Bundle-mode resolution for kpse_find_file_impl (SPEC-latex.md "The
        // resolver"). Returns:
        //   { path: fsPath, bundle, relpath } : hit, ready to allocate
        //   { absent: true }                  : definitive miss
        //   { fallthrough: true }             : format-10 (.fmt) request the
        //     index has no entry for; format files are not bundled, and the
        //     caller's legacy per-file path (on-demand precompiled formats)
        //     should still be tried
        //   { error: outcome, bundle }        : transport-error,
        //     size-mismatch or digest-mismatch fetching the bundle; not a
        //     definitive miss and never memoised
        function resolve(reqname, format) {
            if (!state.indexBytes) return { fallthrough: true };
            var key = format + "/" + reqname;
            var relpath;
            var fresh = false;
            if (state.memo.has(key)) {
                stats.memoHits++;
                relpath = state.memo.get(key);
            } else {
                stats.memoMisses++;
                try {
                    ensureIndex();
                } catch (e) {
                    evidence(reqname, format, "transport-error", [{
                        "source": "bundle-index", "outcome": "index-parse-error"
                    }]);
                    return { error: "index-parse-error", bundle: null };
                }
                var hit = resolveName(format, reqname, state.nameIndex);
                relpath = hit ? hit.path: null;
                fresh = true;
            }
            if (relpath === null) {
                if (fresh) remember(key, null);
                state.sessionKeys.add(key);
                if (format === 10) return { fallthrough: true };
                evidence(reqname, format, "mirror-absent", [{
                    "source": "bundle-index", "outcome": "not-found"
                }]);
                return { absent: true };
            }
            var bundleName = null;
            if (!state.pathsLoaded.has(relpath)) {
                try {
                    ensureIndex();
                } catch (e) {
                    evidence(reqname, format, "transport-error", [{
                        "source": "bundle-index", "outcome": "index-parse-error"
                    }]);
                    return { error: "index-parse-error", bundle: null };
                }
                bundleName = state.index["files"][relpath];
                var bundleMeta = bundleName && state.index["bundles"][bundleName];
                if (!bundleMeta) {
                    // Index inconsistency (files points to a bundle bundles.json
                    // does not list): treat like a miss rather than crash.
                    evidence(reqname, format, "mirror-absent", [{
                        "source": "bundle-index", "outcome": "not-found"
                    }]);
                    return { absent: true };
                }
                if (!state.loaded.has(bundleName)) {
                    var outcome = fetchAndUnpackBundle(bundleName, bundleMeta, reqname, format);
                    if (outcome !== "ok") {
                        evidence(reqname, format, "transport-error", [{
                            "source": "bundle", "outcome": outcome, "bundle": bundleName
                        }]);
                        return { error: outcome, bundle: bundleName };
                    }
                }
            }
            if (fresh) remember(key, relpath);
            state.sessionKeys.add(key);
            var fsPath = texmfRoot + "/" + relpath;
            if (format === 10 && workRoot) {
                // Keep the on-demand-format contract: open_fmt_file() fopen()s
                // the working directory directly, not kpse's return path.
                try {
                    env.FS.writeFile(workRoot + "/" + reqname, env.FS.readFile(fsPath, { encoding: "binary" }));
                } catch (e) {}
            }
            evidence(reqname, format, "resolved", [{
                "source": "bundle", "outcome": "hit", "bundle": bundleName, "path": relpath
            }]);
            return { path: fsPath, bundle: bundleName, relpath: relpath };
        }

        function splitKey(key) {
            var slash = key.indexOf("/");
            return [Number(key.substring(0, slash)), key.substring(slash + 1)];
        }

        // Build the [resolutions, tar] pair for a list of memo keys.
        function exportKeys(keys) {
            var resolutions = [];
            var entries = [];
            var seen = new Set();
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                if (!state.memo.has(key)) continue;
                var relpath = state.memo.get(key);
                var parts = splitKey(key);
                resolutions.push([parts[0], parts[1], relpath]);
                if (relpath === null || seen.has(relpath)) continue;
                seen.add(relpath);
                var bytes;
                try {
                    bytes = env.FS.readFile(texmfRoot + "/" + relpath, { encoding: "binary" });
                } catch (e) {
                    continue;
                }
                entries.push([relpath, bytes]);
            }
            return { resolutions: resolutions, tar: writeTar(entries) };
        }

        function reply(message, transfer) {
            if (typeof env.postMessage !== "function") return;
            if (transfer) env.postMessage(message, transfer);
            else env.postMessage(message);
        }

        function snapshotStats() {
            return {
                indexParsed: stats.indexParsed,
                indexParseMs: stats.indexParseMs,
                memoHits: stats.memoHits,
                memoMisses: stats.memoMisses,
                bundleFetches: stats.bundleFetches,
                bundleFetchMs: stats.bundleFetchMs,
                hashMs: stats.hashMs
            };
        }

        // Process one bundle message. Returns true when data.cmd was one of
        // ours (and a reply has been posted), false otherwise.
        function handle(data) {
            var cmd = data && data["cmd"];
            var msgId = data && data["msgId"];
            if (cmd === "loadbundleindex") {
                var raw = data["data"];
                state.indexBytes = raw instanceof Uint8Array ? raw: new Uint8Array(raw);
                state.index = null;
                state.nameIndex = null;
                reply({ "result": "ok", "cmd": cmd, "msgId": msgId });
                return true;
            }
            if (cmd === "loadworkingset") {
                try {
                    var before = state.pathsLoaded.size;
                    var filesBuf = data["files"];
                    readTar(filesBuf instanceof Uint8Array ? filesBuf: new Uint8Array(filesBuf), writeBundleMember);
                    var members = state.pathsLoaded.size - before;
                    var resolutions = data["resolutions"] || [];
                    for (var i = 0; i < resolutions.length; i++) {
                        var r = resolutions[i];
                        state.memo.set(r[0] + "/" + r[1], r[2]);
                    }
                    reply({ "result": "ok", "cmd": cmd, "msgId": msgId, "files": members });
                } catch (e) {
                    reply({ "result": "failed", "cmd": cmd, "msgId": msgId, "log": String(e && e.message ? e.message: e) });
                }
                return true;
            }
            if (cmd === "workingset") {
                if (!state.dirty) {
                    reply({ "result": "ok", "cmd": cmd, "msgId": msgId, "changed": false, "stats": snapshotStats() });
                    return true;
                }
                var limit = data["limit"];
                var exported = exportKeys(Array.from(state.memo.keys()));
                if (typeof limit === "number" && exported.tar.length > limit) {
                    exported = exportKeys(Array.from(state.sessionKeys));
                }
                state.dirty = false;
                var buffer = exported.tar.buffer;
                reply({
                    "result": "ok", "cmd": cmd, "msgId": msgId, "changed": true,
                    "resolutions": exported.resolutions, "files": buffer, "stats": snapshotStats()
                }, [buffer]);
                return true;
            }
            return false;
        }

        return {
            handle: handle,
            resolve: resolve,
            unpackBundle: unpackBundle,
            writeTar: writeTar,
            get active() { return state.indexBytes !== null; },
            get stats() { return snapshotStats(); },
            loaded: state.loaded,
            pathsLoaded: state.pathsLoaded
        };
    }

    return { create: create, writeTar: writeTar };
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = BundleMode;
}
