// Browser controller for the latexml-oxide Emscripten module.
//
// This is intentionally the same lower-level controller vocabulary as the
// TeX engine workers. EngineDriver can therefore stage a project tree and run
// LaTeX→HTML without knowing whether the underlying binary is C or Rust.

importScripts("kpse-resolve.js", "bundle-mode.js", "latexml.js");

const WORK_ROOT = "/work";
const OUTPUT_ROOT = "/output";
const TEXMF_ROOT = "/texmf";

let moduleInstance;
let bundleMode;
let texliveEndpoint = "";
let mainFile = "main.tex";
const CSS_RESOURCES = [
  "LaTeXML-blue.css", "LaTeXML-marginpar.css", "LaTeXML-navbar-left.css",
  "LaTeXML-navbar-right.css", "LaTeXML.css", "ltx-amsart.css", "ltx-apj.css",
  "ltx-article.css", "ltx-book.css", "ltx-listings.css", "ltx-report.css",
  "ltx-svjour.css", "ltx-ulem.css",
];
const cssResources = new Map();
const projectFiles = new Map();
let runtimeLog = [];
// kpathsea's `kpse_find_file` result is borrowed by the Rust binding: it
// copies the NUL-terminated string into a Rust `String` and does not free the
// pointer. Keep one reusable Rust allocation for resolver results rather than
// allocating once per package lookup. The callback is synchronous, so the
// next lookup cannot overwrite a path before the caller has copied it.
let resolverStringPointer = 0;
let resolverStringCapacity = 0;

function modulePath(path) {
  return new URL(path, self.location.href).href;
}

function allocateString(value) {
  const bytes = new TextEncoder().encode(value);
  const required = bytes.length + 1;
  if (!resolverStringPointer || resolverStringCapacity < required) {
    // The previous pointer came from Rust's allocator as well. Release it
    // before replacing the arena so an unusually long path cannot leak one
    // allocation every time the arena grows.
    releaseResolverString();
    resolverStringCapacity = Math.max(required, resolverStringCapacity * 2, 256);
    resolverStringPointer = moduleInstance._alloc(resolverStringCapacity);
  }
  moduleInstance.HEAPU8.set(bytes, resolverStringPointer);
  moduleInstance.HEAPU8[resolverStringPointer + bytes.length] = 0;
  return resolverStringPointer;
}

function releaseResolverString() {
  if (!resolverStringPointer) return;
  moduleInstance._dealloc(resolverStringPointer, resolverStringCapacity);
  resolverStringPointer = 0;
  resolverStringCapacity = 0;
}

function localFile(name) {
  if (!moduleInstance?.FS) return null;
  const relative = name.replace(/^\/+/, "");
  for (const candidate of [`${WORK_ROOT}/${relative}`, `${TEXMF_ROOT}/${relative}`]) {
    try {
      if (moduleInstance.FS.analyzePath(candidate).exists) return candidate;
    } catch (_) {}
  }
  return null;
}

// Called synchronously by the kpathsea wrapper linked into the Rust module.
// The converter is single-threaded inside this worker, which is the one place
// where BundleMode's synchronous XHR contract is safe.
self.kpse_find_file_impl = function kpseFindFile(namePtr, format) {
  let requested = moduleInstance.UTF8ToString(namePtr);
  if (requested.startsWith("*") || requested.startsWith("&")) requested = requested.slice(1);
  const local = localFile(requested);
  if (local) {
    return allocateString(local);
  }
  if (!bundleMode?.index) return 0;
  const result = bundleMode.resolve(requested, format);
  if (result.path) return allocateString(result.path);
  return 0;
};

function loadCss() {
  // LaTeXML emits a link to LaTeXML.css and may add a document-class sheet.
  // Fetch every sheet upstream can request, but inline only links present in
  // the current document; article and book styles must not be combined.
  return Promise.all(CSS_RESOURCES.map((name) =>
    fetch(modulePath(name === "LaTeXML.css" ? "latexml.css" : name))
      .then((response) => response.ok ? response.text() : "")
      .catch(() => "")
      .then((css) => cssResources.set(name.toLowerCase(), css))
  ));
}

function readText(pointer, length) {
  return new TextDecoder().decode(moduleInstance.HEAPU8.subarray(pointer, pointer + length));
}

function projectPath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") ||
      path.includes("\0") || path.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new Error(`Invalid project file path: ${path}`);
  }
  return path;
}

function normalizeProjectPath(path) {
  const parts = path.split("/");
  const result = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (result.length) result.pop();
      continue;
    }
    result.push(part);
  }
  return result.join("/");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function assetDataUrl(path) {
  if (/^(?:data|blob|https?):/i.test(path) || path.startsWith("#") || path.startsWith("/")) return null;
  const hash = path.indexOf("#");
  const query = path.indexOf("?");
  const end = Math.min(hash < 0 ? path.length : hash, query < 0 ? path.length : query);
  let requested;
  try {
    requested = decodeURIComponent(path.slice(0, end));
  } catch (_) {
    return null;
  }
  const base = mainFile.includes("/") ? mainFile.slice(0, mainFile.lastIndexOf("/")) : "";
  const candidates = [normalizeProjectPath(`${base}/${requested}`), normalizeProjectPath(requested)];
  let bytes;
  let name;
  // The graphics processor owns output names and dimensions. Package the
  // exact output it referenced, including copied or converted resources.
  const outputName = normalizeProjectPath(requested);
  if (outputName) {
    try {
      bytes = moduleInstance.FS.readFile(`${OUTPUT_ROOT}/${outputName}`, { encoding: "binary" });
      name = outputName;
    } catch (_) { /* A source reference may still name a project asset. */ }
  }
  for (const candidate of candidates) {
    if (bytes) break;
    if (projectFiles.has(candidate)) {
      bytes = projectFiles.get(candidate);
      name = candidate;
      break;
    }
  }
  if (!bytes) return null;
  const extension = (name.match(/\.([^.\/]+)$/)?.[1] || "").toLowerCase();
  const mime = {
    avif: "image/avif", gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg",
    png: "image/png", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff",
    webp: "image/webp", bmp: "image/bmp",
  }[extension] || "application/octet-stream";
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

function inlineResources(html) {
  if (!html) return html;
  let hadCss = false;
  html = html.replace(/<link\b[^>]*\bhref\s*=\s*(["'])([^"']+\.css)(?:[?#][^"']*)?\1[^>]*>\s*/gi, (whole, quote, href) => {
    let name;
    try { name = decodeURIComponent(href.split(/[?#]/, 1)[0].split("/").pop()).toLowerCase(); } catch (_) { return whole; }
    const css = cssResources.get(name);
    if (!css) return whole;
    hadCss = true;
    const safeCss = css.replace(/<\/style/gi, "<\\/style");
    return `<style data-latexml-css="${name}">${safeCss}</style>`;
  });
  const coreCss = cssResources.get("latexml.css");
  if (coreCss && !hadCss && !html.includes("data-latexml-css")) {
    const safeCss = coreCss.replace(/<\/style/gi, "<\\/style");
    const style = `<style data-latexml-css="latexml.css">${safeCss}</style>`;
    html = /<head\b[^>]*>/i.test(html)
      ? html.replace(/(<head\b[^>]*>)/i, `$1${style}`)
      : `${style}${html}`;
  }
  return html.replace(/(<(?:img|image)\b[^>]*\s(?:src|href|xlink:href)\s*=\s*["'])([^"']+)(["'])/gi,
    (whole, prefix, source, suffix) => {
      const data = assetDataUrl(source);
      return data ? `${prefix}${data}${suffix}` : whole;
    });
}

function compile(source, name) {
  runtimeLog = [];
  const sourceBytes = new TextEncoder().encode(source);
  const nameBytes = new TextEncoder().encode(name);
  const sourcePtr = moduleInstance._alloc(sourceBytes.length);
  const namePtr = moduleInstance._alloc(nameBytes.length);
  moduleInstance.HEAPU8.set(sourceBytes, sourcePtr);
  moduleInstance.HEAPU8.set(nameBytes, namePtr);
  try {
    moduleInstance._compile(sourcePtr, sourceBytes.length, namePtr, nameBytes.length);
    const outPtr = moduleInstance._output_ptr();
    const outLen = moduleInstance._output_len();
    const status = moduleInstance._status();
    const diagnosticPtr = moduleInstance._diagnostics_ptr();
    const diagnosticLen = moduleInstance._diagnostics_len();
    let html = readText(outPtr, outLen);
    const log = [readText(diagnosticPtr, diagnosticLen), ...runtimeLog].filter(Boolean).join("\n");
    html = inlineResources(html);
    const ok = (status === 0 || status === 1) && Boolean(html);
    return {
      result: ok ? "ok" : "failed",
      cmd: "compile",
      status,
      html: html || null,
      log,
      diagnostics: log ? [{ severity: status === 0 ? "info" : status === 1 ? "warning" : "error", message: log }] : [],
    };
  } finally {
    moduleInstance._dealloc(sourcePtr, sourceBytes.length);
    moduleInstance._dealloc(namePtr, nameBytes.length);
    // The kpathsea Rust binding has copied every result by the time the
    // synchronous compile call returns. Releasing the reusable arena here
    // keeps repeated editor compiles from retaining resolver memory.
    releaseResolverString();
  }
}

function writeFile(path, body) {
  projectPath(path);
  const pathBytes = new TextEncoder().encode(path);
  const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
  projectFiles.set(path, bodyBytes.slice());
  try {
    const slash = path.lastIndexOf("/");
    if (slash >= 0) moduleInstance.FS.mkdirTree(`${WORK_ROOT}/${path.slice(0, slash)}`);
    moduleInstance.FS.writeFile(`${WORK_ROOT}/${path}`, bodyBytes);
  } catch (_) {
    // The Rust ABI keeps the authoritative project tree. MEMFS is only a
    // convenience for readfile and may not have been mounted in a test host.
  }
  const pathPtr = moduleInstance._alloc(pathBytes.length);
  const bodyPtr = moduleInstance._alloc(bodyBytes.length);
  moduleInstance.HEAPU8.set(pathBytes, pathPtr);
  moduleInstance.HEAPU8.set(bodyBytes, bodyPtr);
  try {
    moduleInstance._add_file(pathPtr, pathBytes.length, bodyPtr, bodyBytes.length);
  } finally {
    moduleInstance._dealloc(pathPtr, pathBytes.length);
    moduleInstance._dealloc(bodyPtr, bodyBytes.length);
  }
}

function readFile(path, encoding) {
  projectPath(path);
  try {
    return moduleInstance.FS.readFile(`${WORK_ROOT}/${path}`, { encoding: encoding || "utf8" });
  } catch (_) {
    const bytes = projectFiles.get(path);
    if (!bytes) throw new Error(`File not found: ${path}`);
    return encoding === "binary" ? bytes.slice() : new TextDecoder().decode(bytes);
  }
}

function clearWorkDirectory(path = WORK_ROOT) {
  let entries;
  try {
    entries = moduleInstance.FS.readdir(path);
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (entry === "." || entry === "..") continue;
    const child = `${path}/${entry}`;
    let stat;
    try { stat = moduleInstance.FS.stat(child); } catch (_) { continue; }
    if (moduleInstance.FS.isDir(stat.mode)) {
      clearWorkDirectory(child);
      try { moduleInstance.FS.rmdir(child); } catch (_) {}
    } else {
      try { moduleInstance.FS.unlink(child); } catch (_) {}
    }
  }
}

function initialize() {
  const factory = self.LatexmlModule || self.latexml_wasm || self.Module;
  const options = {
    // The Rust crate's Emscripten stem is `latexml_wasm`, while the published
    // browser pair is deliberately named `latexml.js`/`latexml.wasm`.
    locateFile: (name) => modulePath(name === "latexml_wasm.wasm" ? "latexml.wasm" : name),
    noInitialRun: true,
    print: (line) => runtimeLog.push(String(line)),
    printErr: (line) => runtimeLog.push(String(line)),
  };
  const made = typeof factory === "function" ? factory(options) : factory;
  return Promise.resolve(made).then((instance) => {
    moduleInstance = instance;
    // libkpathsea anchors its search configuration to a program path even
    // when all lookups use the in-process API. It stats this file; no
    // executable or child process is run by the browser worker.
    moduleInstance.FS.writeFile("/kpsewhich", new Uint8Array(), { mode: 0o755 });
    bundleMode = BundleMode.create({
      get FS() { return moduleInstance.FS; },
      texmfRoot: TEXMF_ROOT,
      workRoot: WORK_ROOT,
      endpoint: () => texliveEndpoint,
      postMessage: (message) => self.postMessage(message),
      evidence: (requested, format, outcome, attempts) => {
        self.postMessage({ cmd: "resolver", evidence: { requestedName: requested, format, outcome, attempts } });
      },
    });
    return loadCss();
  }).then((css) => {
    cssText = css;
    self.postMessage({ result: "ok" });
  }).catch((error) => {
    self.postMessage({ result: "failed", status: -254, log: String(error) });
  });
}

self.onmessage = function ({ data }) {
  const cmd = data.cmd;
  try {
    if (cmd === "settexliveurl") {
      texliveEndpoint = data.url || "";
      if (texliveEndpoint && !texliveEndpoint.endsWith("/")) texliveEndpoint += "/";
    } else if (cmd === "setmainfile") {
      mainFile = projectPath(data.url || "main.tex");
      const nameBytes = new TextEncoder().encode(mainFile);
      const namePtr = moduleInstance._alloc(nameBytes.length);
      moduleInstance.HEAPU8.set(nameBytes, namePtr);
      try {
        moduleInstance._set_main(namePtr, nameBytes.length);
      } finally {
        moduleInstance._dealloc(namePtr, nameBytes.length);
      }
    } else if (cmd === "writefile") {
      writeFile(data.url, data.src);
      self.postMessage({ result: "ok", cmd: "writefile" });
    } else if (cmd === "mkdir") {
      projectPath(data.url);
      self.postMessage({ result: "ok", cmd: "mkdir" });
    } else if (cmd === "readfile") {
      try {
        self.postMessage({ result: "ok", cmd: "readfile", url: data.url, data: readFile(data.url, data.encoding) });
      } catch (_) {
        self.postMessage({ result: "failed", cmd: "readfile", url: data.url });
      }
    } else if (cmd === "flushcache") {
      clearWorkDirectory();
      clearWorkDirectory(OUTPUT_ROOT);
      moduleInstance._clear_files();
      projectFiles.clear();
      self.postMessage({ result: "ok", cmd: "flushcache" });
    } else if (cmd === "loadbundleindex") {
      const counts = bundleMode.loadIndex(data.data);
      bundleMode.preloadFromCacheStorage(data.preload).then((cached) => {
        self.postMessage({
          result: "ok", cmd: "loadbundleindex", msgId: data.msgId,
          bundles: counts.bundles,
          files: counts.files,
          cached: cached.cached, skipped: cached.skipped,
        });
      }).catch((error) => self.postMessage({ result: "failed", cmd: "loadbundleindex", msgId: data.msgId, log: String(error) }));
    } else if (cmd === "preloadbundle") {
      const result = bundleMode.preloadBundle(data.name, new Uint8Array(data.data));
      self.postMessage({ result: result === "ok" ? "ok" : "failed", cmd: "preloadbundle", msgId: data.msgId, log: result === "ok" ? "" : result });
    } else if (cmd === "compilelatex") {
      const source = data.source || new TextDecoder().decode(projectFiles.get(mainFile) || new Uint8Array());
      self.postMessage(compile(source, mainFile));
    } else if (cmd === "grace") {
      self.close();
    }
  } catch (error) {
    self.postMessage({ result: "failed", cmd: cmd === "compilelatex" ? "compile" : cmd,
      status: cmd === "compilelatex" ? -254 : 3,
      log: [...runtimeLog, error?.stack || error?.message || JSON.stringify(error) || String(error)].join("\n"), html: null });
  }
};

initialize();
