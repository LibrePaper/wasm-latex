/*
 * makeindex-worker.js — authored Web Worker controller for makeindex WASM (#101).
 *
 * Same shape as bibtex-worker.js: own glue, the kpse_find_file hook for
 * the (optional) -s style `.ist` lookup, heap snapshot/restore for warm reruns.
 * makeindex reads <base>.idx from MEMFS and writes <base>.ind + <base>.ilg.
 */
"use strict";

importScripts("kpse-resolve.js");
importScripts("bundle-mode.js");

var TEXCACHEROOT = "/tex";
var WORKROOT = "/work";
var TEXMFROOT = "/texmf"; // bundle members unpack here; see loadbundleindex

var texlive200_cache = {};
var texlive404_cache = {};

var Module = self.Module = {};
if (self.__librepaperEngineBinary) Module["wasmBinary"] = self.__librepaperEngineBinary;
// The emcc glue still asks for its .wasm by the basename it was built with
// (wasmtex-<engine>.wasm); the file beside it is <engine>.wasm now. Map the
// name here until the engines are rebuilt. A host that hands over the bytes
// through __librepaperEngineBinary never triggers this.
Module["locateFile"] = function(path, prefix) { return (prefix || "") + path.replace(/^wasmtex-/, ""); };

Module["print"] = function(a) {
  self.memlog += a + "\n";
};

Module["printErr"] = function(a) {
  self.memlog += a + "\n";
};

Module["preRun"] = function() {
  FS.mkdir(TEXCACHEROOT);
  FS.mkdir(WORKROOT);
  FS.mkdir(TEXMFROOT);
  FS.chdir(WORKROOT);
};

// Bundle-mode resolver (SPEC-latex.md "The resolver"); shared logic lives in
// wasm-build/bundle-mode.js. self.bundleMode.index stays null until
// loadbundleindex succeeds; kpse_find_file_impl consults it first, after the
// session caches, and falls through to the legacy per-file XHR path only
// when no index is loaded.
self.bundleMode = BundleMode.create({
  get FS() { return FS; },
  texmfRoot: TEXMFROOT,
  workRoot: WORKROOT,
  endpoint: function() { return self.texlive_endpoint; },
  postMessage: function(msg) { self.postMessage(msg); }
});

Module["postRun"] = function() {
  self.initmem = dumpHeapMemory();
  self.postMessage({ "result": "ok" });
};

Module["noExitRuntime"] = true;

self.memlog = "";
self.texlive_endpoint = "";
self.mainfile = "main";

function dumpHeapMemory() {
  return new Uint8Array(wasmMemory.buffer).slice();
}

function restoreHeapMemory() {
  var dst = new Uint8Array(wasmMemory.buffer);
  dst.set(self.initmem);
  if (dst.length > self.initmem.length) {
    dst.fill(0, self.initmem.length);
  }
}

function allocateString(str) {
  var encoder = new TextEncoder();
  var bytes = encoder.encode(str);
  var ptr = _malloc(bytes.length + 1);
  var heap = new Uint8Array(wasmMemory.buffer);
  heap.set(bytes, ptr);
  heap[ptr + bytes.length] = 0;
  return ptr;
}

// kpse hook — only exercised when the document passes a custom `-s style.ist`.
// The common `\printindex` (default style) reads/writes purely local files.
function kpse_find_file_impl(nameptr, format, _mustexist) {
  var reqname = UTF8ToString(nameptr);
  if (reqname.startsWith("*") || reqname.startsWith("&")) {
    reqname = reqname.substring(1);
  }
  if (reqname.includes("/")) return 0;

  // PRIORITY 1: Local VFS
  try {
    var localPath = WORKROOT + "/" + reqname;
    if (FS.analyzePath(localPath).exists) {
      return allocateString(localPath);
    }
  } catch (e) {}

  var cacheKey = format + "/" + reqname;
  if (texlive200_cache[cacheKey]) return allocateString(texlive200_cache[cacheKey]);
  if (texlive404_cache[cacheKey]) return 0;

  if (self.bundleMode.index) {
    var bundleResult = self.bundleMode.resolve(reqname, format);
    if (!bundleResult.fallthrough) {
      if (bundleResult.path !== undefined) {
        texlive200_cache[cacheKey] = bundleResult.path;
        return allocateString(bundleResult.path);
      }
      if (bundleResult.absent) {
        texlive404_cache[cacheKey] = true;
      }
      return 0;
    }
  }

  function tryFetch(name) {
    var url = self.texlive_endpoint + "pdftex/" + format + "/" + name;
    self.postMessage({ "cmd": "downloading", "file": name });
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.timeout = 30000;
    xhr.responseType = "arraybuffer";
    try { xhr.send(); return xhr; } catch (err) { return null; }
  }

  var xhr = tryFetch(reqname);
  // Some object stores answer a missing key with 403 (not 404); retry the bare name.
  if (xhr && xhr.status >= 400 && reqname.includes(".")) {
    var bare = reqname.substring(0, reqname.lastIndexOf("."));
    var retryXhr = tryFetch(bare);
    if (retryXhr && retryXhr.status === 200) { xhr = retryXhr; reqname = bare; }
  }

  if (xhr && xhr.status === 200) {
    var data = new Uint8Array(xhr.response);
    var savepath = TEXCACHEROOT + "/" + reqname;
    FS.writeFile(savepath, data);
    texlive200_cache[cacheKey] = savepath;
    return allocateString(savepath);
  }

  texlive404_cache[cacheKey] = true;
  return 0;
}

function writeTexmfCnf() {
  var cnf = [
    "INDEXSTYLE = .;" + TEXCACHEROOT + "//",
    "TEXINPUTS = .;" + TEXCACHEROOT + "//",
    ""
  ].join("\n");
  FS.writeFile(WORKROOT + "/texmf.cnf", cnf);
}

function compileMakeindexRoutine() {
  self.memlog = "";
  restoreHeapMemory();

  var keys = Object.keys(FS.streams);
  for (var i = 0; i < keys.length; i++) {
    var fd = parseInt(keys[i]);
    if (fd > 2 && FS.streams[fd]) {
      try { FS.close(FS.streams[fd]); } catch (e) {}
    }
  }

  // kpse_set_program_name (kpathsea/progname.c) lstats argv[0] to find the
  // program's own directory (for SELFAUTOLOC-style texmf.cnf expansions). In
  // MEMFS there is no real "makeindex" binary on disk, so without this the
  // lstat fails and kpathsea calls exit(1) before makeindex prints anything
  // or touches the .idx file — silently and misleadingly reported as "ok" by
  // the status<=1 check below. bibtex-worker.js and bibtex8-worker.js already
  // work around this by touching a placeholder file named after argv[0]; do
  // the same here (argv[0] is "makeindex" — see makeindex-entry.c).
  try { FS.writeFile(WORKROOT + "/makeindex", ""); } catch (e) {}

  writeTexmfCnf();
  _setMainEntry(allocateString(self.mainfile));

  var status = 2;
  try {
    status = _compileMakeindex();
  } catch (e) {
    if (typeof ExitStatus !== "undefined" && e instanceof ExitStatus) {
      status = e.status;
    } else {
      console.error("[makeindex] Crash: " + e);
    }
  }

  self.postMessage({
    "cmd": "compile",
    "result": status <= 1 ? "ok" : "error",
    "log": self.memlog
  });
}

function readFileRoutine(url) {
  try {
    var data = FS.readFile(WORKROOT + "/" + url, { encoding: "utf8" });
    self.postMessage({ "cmd": "readfile", "result": "ok", "data": data });
  } catch (e) {
    self.postMessage({ "cmd": "readfile", "result": "error", "data": null });
  }
}

self["onmessage"] = function(ev) {
  var data = ev.data;
  var cmd = data["cmd"];

  if (cmd === "compilemakeindex") {
    self.mainfile = data.url || "main";
    compileMakeindexRoutine();
  } else if (cmd === "writefile") {
    try {
      FS.writeFile(WORKROOT + "/" + data.url, data.src);
      self.postMessage({ "result": "ok", "cmd": "writefile" });
    } catch (e) {
      var parts = data.url.split("/");
      var dir = WORKROOT;
      for (var i = 0; i < parts.length - 1; i++) {
        dir += "/" + parts[i];
        try { FS.mkdir(dir); } catch (e2) {}
      }
      try {
        FS.writeFile(WORKROOT + "/" + data.url, data.src);
        self.postMessage({ "result": "ok", "cmd": "writefile" });
      } catch (e3) {
        self.postMessage({ "result": "failed", "cmd": "writefile" });
      }
    }
  } else if (cmd === "mkdir") {
    try {
      FS.mkdir(WORKROOT + "/" + data.url);
      self.postMessage({ "result": "ok", "cmd": "mkdir" });
    } catch (e) {
      self.postMessage({ "result": "failed", "cmd": "mkdir" });
    }
  } else if (cmd === "readfile") {
    readFileRoutine(data.url);
  } else if (cmd === "settexliveurl") {
    self.texlive_endpoint = data.url;
  } else if (cmd === "loadbundleindex") {
    var libMsgId = data.msgId;
    try {
      self.bundleMode.loadIndex(data.data);
      var bundleCount = Object.keys(self.bundleMode.index.bundles || {}).length;
      var fileCount = Object.keys(self.bundleMode.index.files || {}).length;
      self.bundleMode.preloadFromCacheStorage(data.preload).then(function(result) {
        self.postMessage({
          "result": "ok", "cmd": "loadbundleindex", "msgId": libMsgId,
          "bundles": bundleCount, "files": fileCount,
          "cached": result.cached, "skipped": result.skipped
        });
      }).catch(function(e) {
        self.postMessage({ "result": "failed", "cmd": "loadbundleindex", "msgId": libMsgId, "log": String(e) });
      });
    } catch (e) {
      self.postMessage({ "result": "failed", "cmd": "loadbundleindex", "msgId": libMsgId, "log": String(e) });
    }
  } else if (cmd === "preloadbundle") {
    var pbOutcome = self.bundleMode.preloadBundle(data.name, new Uint8Array(data.data));
    if (pbOutcome !== "ok") {
      self.postMessage({ "result": "failed", "cmd": "preloadbundle", "msgId": data.msgId, "log": pbOutcome + " for bundle " + data.name });
    } else {
      self.postMessage({ "result": "ok", "cmd": "preloadbundle", "msgId": data.msgId });
    }
  }
};

self.kpse_find_file_impl = kpse_find_file_impl;
importScripts("makeindex.js");
