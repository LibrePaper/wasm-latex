// =============================================================================
// bundle-mode.js — bundle-mode resolver shared by every authored engine worker
// =============================================================================
//
// SPEC-latex.md, "Package delivery: bundles, not files" and "The resolver".
// This used to be duplicated (badly — only pdftex-worker.js had it) as
// writeBundleMember/unpackBundle/fetchAndUnpackBundle/resolveViaBundleIndex/
// loadBundleIndexPreload plus the loadbundleindex/preloadbundle message
// handlers. It now lives once, parameterized by an `env` object so every
// worker (pdftex, xetex, luatex, dvipdfm, bibtex, bibtex8, makeindex) can
// plug in its own Emscripten FS, its own texlive_endpoint accessor and its
// own resolver-evidence sink.
//
// Loaded by importScripts('bundle-mode.js') after
// kpse-resolve.js (it uses resolveName/buildNameIndex/sha256Hex/
// readTar from there) and before the generated Emscripten module. The
// CommonJS export at the bottom is a no-op in the worker (where `module` is
// undefined) and lets wasm-build/bundle-mode.test.cjs require() it.
//
// env shape:
//   FS            — the Emscripten FS object (mkdirTree, writeFile, readFile)
//   texmfRoot     — e.g. "/texmf"; bundle members unpack under here
//   workRoot      — optional, e.g. "/work"; format-10 hits are also copied
//                   here, matching open_fmt_file()'s fopen() of the working
//                   directory (see pdftex-worker.js's old resolveViaBundleIndex)
//   endpoint()    — returns the current texlive_endpoint string
//   postMessage   — self.postMessage, for "downloading" progress messages
//   evidence(reqname, format, outcome, attempts) — resolver evidence sink;
//                   may be a no-op for workers that don't wire one up
//   xhrTimeout    — optional, defaults to 150000ms
//   caches        — optional; defaults to the global `caches` (Cache Storage)
//                   when present, disabled (Node harness) otherwise

var BundleMode = (function() {

    function create(env) {
        // env.FS is not captured into a local here: it is the Emscripten
        // runtime's FS global, which does not exist yet when the worker
        // creates its BundleMode instance (importScripts('bundle-mode.js')
        // runs before importScripts of the generated engine module). Every
        // access below goes through env.FS at call time instead, by which
        // point the engine has finished loading.
        var texmfRoot = env.texmfRoot;
        var workRoot = env.workRoot || null;
        var cacheStorage = "caches" in env ? env.caches : (typeof caches !== "undefined" ? caches : undefined);
        var xhrTimeout = env.xhrTimeout || 150000;

        function evidence(reqname, format, outcome, attempts) {
            if (typeof env.evidence === "function") env.evidence(reqname, format, outcome, attempts);
        }

        var state = {
            index: null,           // parsed bundles.json
            nameIndex: null,       // Map: basename -> [texmf-relative path, ...]
            loaded: new Set(),     // bundle names already unpacked into texmfRoot
            pathsLoaded: new Set() // texmf-relative paths already written
        };

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
        // already unpacked this session (including one restored from Cache
        // Storage) is never re-unpacked.
        function unpackBundle(name, bytes) {
            if (state.loaded.has(name)) return;
            readTar(bytes, writeBundleMember);
            state.loaded.add(name);
        }

        // Fetch one bundle by synchronous XHR, verify it against the index's
        // sha256, and unpack it. Returns "ok", "transport-error" (network
        // failure or non-200 — never poisons a 404 cache, since the file may
        // well exist; only the transport failed), or "digest-mismatch". On
        // success also stashes the bytes in Cache Storage (fire-and-forget) so
        // the next session skips the network entirely (SPEC-latex.md "Browser
        // cache").
        function fetchAndUnpackBundle(name, meta, reqname, format) {
            if (typeof env.postMessage === "function") {
                env.postMessage({ "cmd": "downloading", "file": reqname, "bundle": name, "size": meta.size });
            }
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
            if (sha256Hex(bytes) !== meta.sha256) return "digest-mismatch";
            unpackBundle(name, bytes);
            if (cacheStorage) {
                cacheStorage.open("librepaper-bundles").then(function(cache) {
                    return cache.put(url, new Response(bytes.slice()));
                }).catch(function(e) {});
            }
            return "ok";
        }

        // Parse and install an index (bundles.json). indexBytesOrString is a
        // string or an ArrayBuffer/Uint8Array of UTF-8 JSON. Throws on parse
        // failure; caller decides how to report that.
        function loadIndex(indexBytesOrString) {
            var text = typeof indexBytesOrString === "string"
                ? indexBytesOrString
                : new TextDecoder("utf-8").decode(
                    indexBytesOrString instanceof Uint8Array
                        ? indexBytesOrString
                        : new Uint8Array(indexBytesOrString)
                  );
            var parsed = JSON.parse(text);
            state.index = parsed;
            state.nameIndex = buildNameIndex(parsed["files"] || {});
            return {
                bundles: Object.keys(parsed["bundles"] || {}).length,
                files: Object.keys(parsed["files"] || {}).length
            };
        }

        // Restore bundles previously verified and stashed in Cache Storage
        // (SPEC-latex.md "Browser cache"). Without `names`, every cached bundle
        // whose URL matches the index is restored (legacy/default behaviour).
        // With `names` (an array of bundle names), only those bundles are
        // restored — item 7's scoped preload — and any bundle present in the
        // cache but not named is left alone and counted in `skipped`.
        //
        // A cached entry whose digest no longer matches the index (a stale
        // release) is deleted from the cache instead of being unpacked or
        // counted; it is not "cached" and not "skipped" either.
        //
        // Returns a Promise<{ cached, skipped }>. Resolves with { cached: 0,
        // skipped: 0 } when Cache Storage is unavailable (the Node harness).
        function preloadFromCacheStorage(names) {
            if (!state.index) return Promise.resolve({ cached: 0, skipped: 0 });
            if (!cacheStorage) return Promise.resolve({ cached: 0, skipped: 0 });

            var scope = null;
            if (Array.isArray(names)) {
                scope = new Set(names);
            }

            var urlToName = {};
            for (var name in state.index.bundles) {
                if (Object.prototype.hasOwnProperty.call(state.index.bundles, name)) {
                    urlToName[state.index.bundles[name].url] = name;
                }
            }
            function bundleNameForUrl(fullUrl) {
                for (var u in urlToName) {
                    if (Object.prototype.hasOwnProperty.call(urlToName, u) &&
                        fullUrl.length >= u.length &&
                        fullUrl.lastIndexOf(u) === fullUrl.length - u.length) {
                        return urlToName[u];
                    }
                }
                return null;
            }

            return cacheStorage.open("librepaper-bundles").then(function(cache) {
                return cache.keys().then(function(requests) {
                    var cachedCount = 0;
                    var skippedCount = 0;
                    var tasks = requests.map(function(request) {
                        var matchName = bundleNameForUrl(request.url);
                        if (!matchName) return null;
                        if (state.loaded.has(matchName)) return null;
                        if (scope && !scope.has(matchName)) {
                            skippedCount++;
                            return null;
                        }
                        return cache.match(request).then(function(response) {
                            if (!response) return;
                            return response.arrayBuffer().then(function(buf) {
                                var bytes = new Uint8Array(buf);
                                var meta = state.index.bundles[matchName];
                                if (!meta || sha256Hex(bytes) !== meta.sha256) {
                                    // Stale entry (release rotated under us):
                                    // drop it so a later fetch does not read
                                    // the same mismatched bytes back out of
                                    // Cache Storage.
                                    return cache.delete(request);
                                }
                                unpackBundle(matchName, bytes);
                                cachedCount++;
                            });
                        }).catch(function(e) {});
                    }).filter(function(p) { return p; });
                    return Promise.all(tasks).then(function() {
                        return { cached: cachedCount, skipped: skippedCount };
                    });
                });
            });
        }

        // Verify and unpack one bundle the host already fetched (e.g. off a
        // Cache Storage read on the main thread, or from a fetch() the host
        // did because the worker cannot do async XHR mid-compile). Returns
        // "ok" or an error string ("unknown-bundle", "digest-mismatch").
        function preloadBundle(name, bytes) {
            var meta = state.index && state.index.bundles[name];
            if (!meta) return "unknown-bundle";
            var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            if (sha256Hex(u8) !== meta.sha256) return "digest-mismatch";
            unpackBundle(name, u8);
            return "ok";
        }

        // Bundle-mode resolution for kpse_find_file_impl (SPEC-latex.md "The
        // resolver"). Returns:
        //   { path: fsPath, bundle, relpath }  — hit, ready to allocate
        //   { absent: true }                   — definitive miss
        //   { fallthrough: true }              — format-10 (.fmt) request the
        //     index has no entry for; format files are not bundled, and the
        //     caller's legacy per-file path (on-demand precompiled formats)
        //     should still be tried
        //   { error: outcome, bundle }         — transport-error or
        //     digest-mismatch fetching the bundle; not a definitive miss
        function resolve(reqname, format) {
            if (!state.index) return { fallthrough: true };
            var hit = resolveName(format, reqname, state.nameIndex);
            if (!hit) {
                if (format === 10) return { fallthrough: true };
                evidence(reqname, format, "mirror-absent", [{
                    "source": "bundle-index", "outcome": "not-found"
                }]);
                return { absent: true };
            }
            var relpath = hit.path;
            var bundleName = state.index.files[relpath];
            var bundleMeta = bundleName && state.index.bundles[bundleName];
            if (!bundleMeta) {
                // Index inconsistency (files points to a bundle bundles.json
                // does not list) — treat like a miss rather than crash.
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

        return {
            loadIndex: loadIndex,
            preloadFromCacheStorage: preloadFromCacheStorage,
            preloadBundle: preloadBundle,
            resolve: resolve,
            unpackBundle: unpackBundle,
            get index() { return state.index; },
            get nameIndex() { return state.nameIndex; },
            loaded: state.loaded,
            pathsLoaded: state.pathsLoaded
        };
    }

    return { create: create };
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = BundleMode;
}
