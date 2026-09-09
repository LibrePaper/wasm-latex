/* =============================================================================
 * dvipdfm-worker.js — authored worker controller for dvipdfmx
 * =============================================================================
 *
 * Published verbatim as dvipdfm.worker.js. It configures Module, owns the
 * protocol/cache policy, then imports the generated dvipdfm.js core. The
 * WebAssembly itself is the GPL dvipdfmx engine built from texlive-source.
 *
 * Protocol:
 *   compilepdf → run _compilePDF on the .xdv the driver wrote, post back the .pdf.
 *   settexliveurl / writefile / readfile / mkdir / setmainfile / flushcache / grace.
 *
 * Resolves TeX Live files over HTTP against THIS project's CDN layout
 * (`${endpoint}/pdftex/<format>/<name>`, shared with the pdfTeX mirror), routing by
 * extension (.otf→47, .ttf/.ttc→36, .pfb→32, .afm→4) and appending the kpse format's
 * canonical extension for extension-less lookups — exactly like the XeTeX glue.
 * ========================================================================== */

importScripts('xetex-resolver-evidence.js')
importScripts('kpse-resolve.js')
importScripts('bundle-mode.js')

const TEXCACHEROOT = '/tex'
const WORKROOT = '/work'
const TEXMFROOT = '/texmf' // bundle members unpack here; see loadbundleindex
// biome-ignore lint: emscripten populates Module
var Module = self.Module = {}
if (self.__librepaperEngineBinary) Module.wasmBinary = self.__librepaperEngineBinary
// The emcc glue still asks for its .wasm by the basename it was built with
// (wasmtex-<engine>.wasm); the file beside it is <engine>.wasm now. Map the
// name here until the engines are rebuilt. A host that hands over the bytes
// through __librepaperEngineBinary never triggers this.
Module["locateFile"] = function(path, prefix) { return (prefix || "") + path.replace(/^wasmtex-/, "") }
self.memlog = ''
self.mainfile = 'main.tex'
self.texlive_endpoint = ''

Module.print = (a) => {
  self.memlog += `${a}\n`
}
Module.printErr = (a) => {
  self.memlog += `${a}\n`
}
Module.preRun = () => {
  FS.mkdir(TEXCACHEROOT)
  FS.mkdir(WORKROOT)
  FS.mkdir(TEXMFROOT)
}

// Bundle-mode resolver (SPEC-latex.md "The resolver"); shared logic lives in
// wasm-build/bundle-mode.js. self.bundleMode.index stays null until
// loadbundleindex succeeds; kpse_find_file_impl consults it first, after the
// session caches, and falls through to the legacy per-file XHR path only
// when no index is loaded.
self.bundleMode = BundleMode.create({
  get FS() { return FS },
  texmfRoot: TEXMFROOT,
  workRoot: WORKROOT,
  endpoint: () => self.texlive_endpoint,
  postMessage: (msg) => self.postMessage(msg),
  evidence: (...args) => self.resolverEvidence(...args),
})
Module.postRun = () => {
  self.postMessage({ result: 'ok' })
  self.initmem = dumpHeapMemory() // pristine post-init heap, restored before each compile (#82)
}
Module.onAbort = () => {
  self.memlog += 'Engine crashed'
  self.postMessage({ result: 'failed', status: -254, log: self.memlog, cmd: 'compile' })
}

function _allocate(content) {
  const res = _malloc(content.length)
  HEAPU8.set(new Uint8Array(content), res)
  return res
}

// --- Heap snapshot: reset C state between compiles in the same worker ----------
// dvipdfmx's main() is NOT re-entrant — its globals (loaded-font table, fontmap hash,
// page device) persist across calls under EXIT_RUNTIME=0, so a warm 2nd compile fails
// with "No font selected!" and the 3rd crashes (#82). Snapshot the pristine post-init
// heap and restore it before every compile. The font/map cache lives in MEMFS (JS
// side, outside the wasm heap), so it survives the restore — no re-fetch. Mirrors the
// xetex worker. `.set(initmem)` into a (possibly grown) buffer rewrites only the
// pristine prefix; the grown tail is unused capacity, which is correct.
function dumpHeapMemory() {
  const src = HEAPU8.buffer
  const dst = new Uint8Array(src.byteLength)
  dst.set(new Uint8Array(src))
  return dst
}
function restoreHeapMemory() {
  if (self.initmem) new Uint8Array(HEAPU8.buffer).set(self.initmem)
}

/** Run an engine entry point. The from-texlive-source dvipdfmx ends by calling
 *  exit(); under emscripten that throws ExitStatus instead of returning, so catch it
 *  and surface the exit code (the .pdf was written before exit). */
function runEngine(fn) {
  try {
    return fn()
  } catch (e) {
    if (e && (e.name === 'ExitStatus' || typeof e.status === 'number')) return e.status
    // A wasm trap (RuntimeError) or other JS error — NOT a normal exit. Record it and
    // return a non-zero status so the driver reports a clear failure. Re-throwing here
    // lets the error escape the message handler with no result posted, which looks
    // exactly like a hang (#52: a paperinit signature-mismatch trap masqueraded as a
    // hang for precisely this reason).
    self.memlog += `\nEngine error: ${(e && e.stack) || e}\n`
    return -1
  }
}

/** texmf.cnf for the from-source dvipdfmx's REAL libkpathsea (font search paths). */
function writeTexmfCnf() {
  const c = `${TEXCACHEROOT}//`
  FS.writeFile(
    `${WORKROOT}/texmf.cnf`,
    [
      `TEXMFCNF = .;${WORKROOT}`,
      `TEXFONTMAPS = .;${c}`,
      `OPENTYPEFONTS = .;${c}`,
      `TTFONTS = .;${c}`,
      `T1FONTS = .;${c}`,
      `TFMFONTS = .;${c}`,
      `VFFONTS = .;${c}`,
      `ENCFONTS = .;${c}`,
      `CMAPFONTS = .;${c}`,
      `TEXPSHEADERS = .;${c}`,
      `TEXINPUTS = .;${c}`,
      '',
    ].join('\n'),
  )
}

function cleanDir(dir) {
  for (const item of FS.readdir(dir)) {
    if (item === '.' || item === '..') continue
    const path = `${dir}/${item}`
    let st
    try {
      st = FS.stat(path)
    } catch {
      continue
    }
    if (FS.isDir(st.mode)) cleanDir(path)
    else {
      try {
        FS.unlink(path)
      } catch {}
    }
  }
  if (dir !== WORKROOT) {
    try {
      FS.rmdir(dir)
    } catch {}
  }
}

/** Run dvipdfmx on the .xdv the driver wrote, then post back the produced .pdf.
 *  Restores the pristine heap first so repeated compiles on one worker each start
 *  from a clean dvipdfmx state (#82). */
// TeX names its outputs after the job, not after the path it was given. A run
// over `paper/main.tex` writes `main.pdf`, `main.log` and `main.synctex.gz`
// into the working directory, so an output path built from the full input path
// names a file that was never written: the compile succeeds, and the caller is
// handed no PDF. The job name is the input's base name without its extension.
function jobNameForMain(mainFile) {
  var name = mainFile.slice(mainFile.lastIndexOf('/') + 1)
  return name.replace(/\.[^.]+$/, '')
}

function compilePDFRoutine() {
  self.memlog = ''
  restoreHeapMemory()
  FS.chdir(WORKROOT)
  // Real libkpathsea (from-source dpx) derives the program dir from argv[0] (no
  // /proc/self/exe under WASM); a dummy absolute binary + texmf.cnf let SELFAUTO*
  // resolve to /work and find the search paths.
  try {
    FS.writeFile(`${WORKROOT}/xdvipdfmx`, '')
  } catch {}
  writeTexmfCnf()
  cwrap('setMainEntry', 'number', ['string'])(self.mainfile)
  const status = runEngine(_compilePDF)
  if (status !== 0) {
    self.postMessage({ result: 'failed', status, log: self.memlog, cmd: 'compile' })
    return
  }
  try {
    // The driver sets the main file to the .xdv (e.g. main.xdv); dvipdfmx writes
    // main.pdf beside it in the working directory, under the job name.
    const pdf = FS.readFile(`${WORKROOT}/${jobNameForMain(self.mainfile)}.pdf`, {
      encoding: 'binary',
    })
    self.postMessage(
      { result: 'ok', status: 0, log: self.memlog, pdf: pdf.buffer, cmd: 'compile' },
      [pdf.buffer],
    )
  } catch {
    self.postMessage({ result: 'failed', status: -253, log: self.memlog, cmd: 'compile' })
  }
}

self.onmessage = (ev) => {
  const data = ev.data
  const cmd = data.cmd
  if (cmd === 'compilepdf') compilePDFRoutine()
  else if (cmd === 'settexliveurl') {
    let url = data.url
    if (url && !url.endsWith('/')) url += '/'
    self.texlive_endpoint = url || ''
  } else if (cmd === 'mkdir') {
    try {
      FS.mkdir(`${WORKROOT}/${data.url}`)
    } catch {}
  } else if (cmd === 'writefile') {
    try {
      FS.writeFile(`${WORKROOT}/${data.url}`, data.src)
      self.postMessage({ result: 'ok', cmd: 'writefile' })
    } catch {
      self.postMessage({ result: 'failed', cmd: 'writefile' })
    }
  } else if (cmd === 'readfile') {
    try {
      const d = FS.readFile(`${WORKROOT}/${data.url}`, { encoding: data.encoding || 'utf8' })
      self.postMessage({ result: 'ok', cmd: 'readfile', url: data.url, data: d })
    } catch {
      self.postMessage({ result: 'failed', cmd: 'readfile', url: data.url })
    }
  } else if (cmd === 'setmainfile') {
    self.mainfile = data.url
  } else if (cmd === 'preloadtexlive') {
    try {
      const savepath = `${TEXCACHEROOT}/${data.filename}`
      FS.writeFile(savepath, new Uint8Array(data.data))
      const cacheKey = `${data.format}/${data.filename}`
      texlive200[cacheKey] = savepath
      texlive200Source[cacheKey] = data.source === 'persistent-cache'
        ? 'persistent-cache'
        : 'warmup-cache'
      delete texlive404[cacheKey]
      delete texlive404Source[cacheKey]
    } catch {}
  } else if (cmd === 'preload404') {
    for (const entry of data.entries || []) {
      const cacheKey = `${entry.format}/${entry.filename}`
      if (!(cacheKey in texlive200)) {
        texlive404[cacheKey] = 1
        texlive404Source[cacheKey] = data.source === 'durable-negative'
          ? 'durable-negative'
          : 'warmup-negative'
      }
    }
  } else if (cmd === 'dumpcache') {
    const files = []
    const transfer = []
    for (const key in texlive200) {
      const slash = key.indexOf('/')
      if (slash < 0) continue
      try {
        const bytes = FS.readFile(texlive200[key], { encoding: 'binary' })
        const copy = new Uint8Array(bytes.length)
        copy.set(bytes)
        files.push({ format: Number(key.slice(0, slash)), filename: key.slice(slash + 1), data: copy.buffer })
        transfer.push(copy.buffer)
      } catch {}
    }
    const notFound = Object.keys(texlive404).map((key) => {
      const slash = key.indexOf('/')
      return { format: Number(key.slice(0, slash)), filename: key.slice(slash + 1) }
    })
    self.postMessage({ result: 'ok', cmd: 'dumpcache', files, notFound }, transfer)
  } else if (cmd === 'flushcache') {
    cleanDir(WORKROOT)
  } else if (cmd === 'loadbundleindex') {
    // SPEC-latex.md "The index" / "The resolver". data: {data, msgId, preload?}.
    const msgId = data.msgId
    try {
      self.bundleMode.loadIndex(data.data)
      const bundleCount = Object.keys(self.bundleMode.index.bundles || {}).length
      const fileCount = Object.keys(self.bundleMode.index.files || {}).length
      self.bundleMode.preloadFromCacheStorage(data.preload).then((result) => {
        self.postMessage({
          result: 'ok', cmd: 'loadbundleindex', msgId,
          bundles: bundleCount, files: fileCount,
          cached: result.cached, skipped: result.skipped,
        })
      }).catch((e) => {
        self.postMessage({ result: 'failed', cmd: 'loadbundleindex', msgId, log: String(e) })
      })
    } catch (e) {
      self.postMessage({ result: 'failed', cmd: 'loadbundleindex', msgId, log: String(e) })
    }
  } else if (cmd === 'preloadbundle') {
    const outcome = self.bundleMode.preloadBundle(data.name, new Uint8Array(data.data))
    if (outcome !== 'ok') {
      self.postMessage({ result: 'failed', cmd: 'preloadbundle', msgId: data.msgId, log: `${outcome} for bundle ${data.name}` })
    } else {
      self.postMessage({ result: 'ok', cmd: 'preloadbundle', msgId: data.msgId })
    }
  } else if (cmd === 'grace') {
    self.close()
  }
}

// --- kpse over HTTP against the TeX Live package CDN -------------------------
const texlive404 = {}
const texlive200 = {}
const texlive404Source = {}
const texlive200Source = {}

/** Canonical extension for a kpse format (for extension-less requests). Mirrors
 *  the same fix in xetex-worker.js: 3 (TFM), 33 (VF), 11 (map) and 44 (enc) were
 *  missing, so a non-font extension-less lookup (e.g. a TFM sidecar) resolved to
 *  the bare CDN name instead of "<name>.tfm" and 404'd. */
const FORMAT_EXT = {
  3: '.tfm', 4: '.afm', 6: '.bib', 7: '.bst', 11: '.map',
  26: '.tex', 32: '.pfb', 33: '.vf', 36: '.ttf', 44: '.enc', 47: '.otf',
}

/** Ordered [dir, filename] candidates for the CDN request. Files WITH a known
 *  extension map to their canonical dir. Extension-LESS names are native-font
 *  lookups: XeTeX caches OpenType fonts without an extension, and from-source
 *  dvipdfmx asks for them with kpse_truetype_format(36) even when the file is an
 *  OTF — so we can't trust `format`. Try the common font containers in order
 *  (OTF first, as XeTeX native fonts usually are) until one returns 200. */
function cdnCandidates(reqname, format) {
  const lower = reqname.toLowerCase()
  if (lower.endsWith('.otf')) return [['47', reqname]]
  if (lower.endsWith('.ttf') || lower.endsWith('.ttc')) return [['36', reqname]]
  if (lower.endsWith('.pfb')) return [['32', reqname]]
  if (lower.endsWith('.afm')) return [['4', reqname]]
  if (reqname.includes('.')) return [[String(format), reqname]]
  // Extension-less + a native sfnt-font format (kpse opentype=47 / truetype=36):
  // the file may be any container — XeTeX caches OTFs without an extension and
  // from-source dvipdfmx asks for them with truetype format. Try the common
  // containers, OTF first. ONLY for 47/36: doing this for e.g. TFM(3) once fetched
  // a .pfb where a .tfm was expected ("Can't proceed..." on a size mismatch).
  if (format === 47 || format === 36) {
    return [
      ['47', `${reqname}.otf`],
      ['36', `${reqname}.ttf`],
      ['36', `${reqname}.ttc`],
      ['32', `${reqname}.pfb`],
    ]
  }
  // All other formats (TFM=3, AFM=4, ...): single canonical path.
  return [[String(format), `${reqname}${FORMAT_EXT[format] || ''}`]]
}

function kpse_find_file_impl(nameptr, format) {
  let reqname = UTF8ToString(nameptr)
  // dvipdfmx re-resolves a font by the FULL path we returned (e.g.
  // `/tex/lmroman10-regular`) to open it — strip the cache-root prefix so the
  // second lookup is a cache hit instead of being rejected by the slash guard.
  if (reqname.startsWith(`${TEXCACHEROOT}/`)) reqname = reqname.slice(TEXCACHEROOT.length + 1)
  // Bundle-mode hits live under TEXMFROOT (a relative texmf path, possibly with
  // its own "/"s); strip that prefix too so a re-resolve of the full path we
  // returned (dvipdfmx re-opens fonts this way) is a plain basename lookup and
  // hits texlive200 instead of the slash guard below.
  if (reqname.startsWith(`${TEXMFROOT}/`)) reqname = reqname.slice(reqname.lastIndexOf('/') + 1)
  if (reqname.includes('/')) return 0
  const cacheKey = `${format}/${reqname}`
  if (cacheKey in texlive404) {
    self.resolverEvidence(reqname, format, 'mirror-absent', [{
      source: texlive404Source[cacheKey] || 'durable-negative', outcome: 'not-found',
    }])
    return 0
  }
  if (cacheKey in texlive200) {
    self.resolverEvidence(reqname, format, 'resolved', [{
      source: texlive200Source[cacheKey] || 'session-cache', outcome: 'hit',
    }])
    return _allocate(intArrayFromString(texlive200[cacheKey]))
  }

  if (self.bundleMode.index) {
    const result = self.bundleMode.resolve(reqname, format)
    if (!result.fallthrough) {
      if (result.path !== undefined) {
        texlive200[cacheKey] = result.path
        texlive200Source[cacheKey] = 'bundle'
        delete texlive404Source[cacheKey]
        return _allocate(intArrayFromString(result.path))
      }
      if (result.absent) {
        texlive404[cacheKey] = 1
        texlive404Source[cacheKey] = 'bundle-index'
      }
      return 0
    }
  }

  const attempts = []
  for (const [dir, filename] of cdnCandidates(reqname, format)) {
    const url = `${self.texlive_endpoint}pdftex/${dir}/${filename}`
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url, false)
    xhr.responseType = 'arraybuffer'
    try {
      xhr.send()
    } catch {
      attempts.push({ source: 'network', outcome: 'transport-error', candidate: filename })
      continue
    }
    attempts.push({
      source: 'network',
      outcome: xhr.status === 200 ? 'hit' : 'not-found',
      candidate: filename,
      status: xhr.status,
    })
    if (xhr.status === 200) {
      const bytes = new Uint8Array(xhr.response)
      // Save at the MATCHED-extension path (e.g. /tex/lmroman10-regular.otf): for an
      // absolute, extension-less native-font name dvi_locate_native_font() bypasses
      // kpse and opens `<name>.otf`/`.ttf`/`.pfb` directly (ensuresuffix + xstrdup),
      // so the file must exist at that suffixed path. Also save at the bare requested
      // name for callers that open the kpse-returned path verbatim.
      const withExt = `${TEXCACHEROOT}/${filename}`
      const bare = `${TEXCACHEROOT}/${reqname}`
      FS.writeFile(withExt, bytes)
      if (bare !== withExt) {
        try {
          FS.writeFile(bare, bytes)
        } catch {}
      }
      texlive200[cacheKey] = withExt
      texlive200Source[cacheKey] = 'session-cache'
      // Also key by the matched filename so a re-lookup by the returned path
      // (/tex/name.otf -> name.otf) or by the container's own format dir hits the
      // cache instead of re-fetching the same file from the CDN.
      texlive200[`${format}/${filename}`] = withExt
      texlive200[`${dir}/${filename}`] = withExt
      texlive200Source[`${format}/${filename}`] = 'session-cache'
      texlive200Source[`${dir}/${filename}`] = 'session-cache'
      self.postMessage({ cmd: 'downloading', file: reqname })
      self.resolverEvidence(reqname, format, 'resolved', attempts)
      return _allocate(intArrayFromString(withExt))
    }
  }
  const mirrorAbsent = attempts.length > 0 && attempts.every((attempt) => attempt.outcome === 'not-found')
  if (mirrorAbsent) {
    texlive404[cacheKey] = 1
    texlive404Source[cacheKey] = 'network'
  }
  self.resolverEvidence(
    reqname,
    format,
    mirrorAbsent ? 'mirror-absent' : 'transport-error',
    attempts,
  )
  return 0
}

self.kpse_find_file_impl = kpse_find_file_impl
importScripts('dvipdfm.js')
