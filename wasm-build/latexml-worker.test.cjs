// Protocol check for the authored LaTeXML worker. This deliberately runs the
// real resolver and BundleMode code in a worker-like VM, while replacing only
// the generated Emscripten module and browser fetch/XHR boundary.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname)
const workerSource = fs.readFileSync(path.join(root, 'latexml-worker.js'), 'utf8')
const kpseSource = fs.readFileSync(path.join(root, 'kpse-resolve.cjs'), 'utf8')
const bundleSource = fs.readFileSync(path.join(root, 'bundle-mode.js'), 'utf8')

class MockFS {
  constructor() {
    this.files = new Map()
    this.dirs = new Set(['/'])
  }

  mkdirTree(name) {
    const parts = name.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current += `/${part}`
      this.dirs.add(current)
    }
  }

  writeFile(name, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
    this.mkdirTree(name.slice(0, name.lastIndexOf('/')))
    this.files.set(name, bytes.slice())
  }

  readFile(name, options = {}) {
    const bytes = this.files.get(name)
    if (!bytes) throw new Error(`missing ${name}`)
    return options.encoding === 'binary' ? bytes.slice() : new TextDecoder().decode(bytes)
  }

  readdir(name) {
    if (!this.dirs.has(name)) throw new Error(`missing directory ${name}`)
    const prefix = name === '/' ? '/' : `${name}/`
    const children = new Set(['.', '..'])
    for (const directory of this.dirs) {
      if (!directory.startsWith(prefix) || directory === name) continue
      const rest = directory.slice(prefix.length)
      if (rest && !rest.includes('/')) children.add(rest)
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      if (rest && !rest.includes('/')) children.add(rest)
    }
    return [...children]
  }

  stat(name) {
    if (this.dirs.has(name)) return { mode: 0o040000 }
    if (this.files.has(name)) return { mode: 0o100000 }
    throw new Error(`missing ${name}`)
  }

  isDir(mode) { return (mode & 0o170000) === 0o040000 }
  unlink(name) { this.files.delete(name) }
  rmdir(name) { this.dirs.delete(name) }

  analyzePath(name) {
    return { exists: this.dirs.has(name) || this.files.has(name) }
  }
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return header
}

function tarFile(name, content) {
  const bytes = Buffer.from(content)
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512)
  return Buffer.concat([tarHeader(name, bytes.length), bytes, padding, Buffer.alloc(1024)])
}

function makeModule() {
  const buffer = new ArrayBuffer(2 * 1024 * 1024)
  const module = {
    HEAPU8: new Uint8Array(buffer),
    FS: new MockFS(),
    allocations: [],
    deallocations: [],
    files: new Map(),
    main: '',
    output: { pointer: 0, length: 0 },
    diagnostics: { pointer: 0, length: 0 },
    next: 1024,
  }
  module.growMemory = () => {
    const grown = new Uint8Array(module.HEAPU8.length * 2)
    grown.set(module.HEAPU8)
    module.HEAPU8 = grown
  }
  module._alloc = (length) => {
    const pointer = module.next
    module.next += Math.max(length, 1)
    module.allocations.push({ pointer, length })
    return pointer
  }
  module._dealloc = (pointer, length) => module.deallocations.push({ pointer, length })
  const read = (pointer, length) => new TextDecoder().decode(module.HEAPU8.subarray(pointer, pointer + length))
  const write = (text) => {
    const bytes = new TextEncoder().encode(text)
    const pointer = module._alloc(bytes.length)
    module.HEAPU8.set(bytes, pointer)
    return { pointer, length: bytes.length }
  }
  module.UTF8ToString = (pointer) => {
    let end = pointer
    while (module.HEAPU8[end]) end++
    return read(pointer, end - pointer)
  }
  module._add_file = (pathPointer, pathLength, bodyPointer, bodyLength) => {
    const name = read(pathPointer, pathLength)
    module.files.set(name, module.HEAPU8.slice(bodyPointer, bodyPointer + bodyLength))
  }
  module._clear_files = () => module.files.clear()
  module._set_main = (pointer, length) => { module.main = read(pointer, length) }
  module._compile = (sourcePointer, sourceLength, namePointer, nameLength) => {
    assert.equal(read(namePointer, nameLength), module.main)
    assert.equal(read(sourcePointer, sourceLength), new TextDecoder().decode(module.files.get(module.main)))
    const output = write('<html><head><link rel="stylesheet" href="LaTeXML.css"><link rel="stylesheet" href="ltx-book.css"></head><body><img src="img.png"><svg><image xlink:href="img.png"></image></svg></body></html>')
    const diagnostics = write('one recoverable warning')
    module.output = output
    module.diagnostics = diagnostics
  }
  module._status = () => 1
  module._output_ptr = () => module.output.pointer
  module._output_len = () => module.output.length
  module._diagnostics_ptr = () => module.diagnostics.pointer
  module._diagnostics_len = () => module.diagnostics.length
  return module
}

async function main() {
  const module = makeModule()
  const messages = []
  const self = {
    location: { href: 'https://mirror.test/engines/r/latexml.worker.js' },
    postMessage: (message) => messages.push(message),
    close: () => { self.closed = true },
  }
  const context = {
    self,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
    Promise,
    Response,
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    fetch: async () => ({ ok: true, text: async () => 'body { color: red; }' }),
    console,
    performance,
    setTimeout,
    clearTimeout,
    XMLHttpRequest: class {},
    moduleInstance: null,
  }
  context.importScripts = (...names) => {
    for (const name of names) {
      if (name === 'kpse-resolve.js') vm.runInContext(kpseSource, context)
      else if (name === 'bundle-mode.js') vm.runInContext(bundleSource, context)
      else if (name === 'latexml.js') self.LatexmlModule = () => Promise.resolve(module)
      else throw new Error(`unexpected import ${name}`)
    }
  }
  vm.createContext(context)
  vm.runInContext(workerSource, context, { filename: 'latexml-worker.js' })
  await new Promise((resolve) => setImmediate(resolve))
  const message = () => JSON.parse(JSON.stringify(messages.shift()))
  assert.deepEqual(message(), { result: 'ok' })

  const tar = tarFile('tex/latex/base/foo.sty', 'package')
  const digest = crypto.createHash('sha256').update(tar).digest('hex')
  const tarBuffer = Uint8Array.from(tar).buffer
  const longName = `tex/latex/base/${'long-'.repeat(80)}.sty`
  const index = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    bundles: { core: { url: `b/${digest}/core.tar`, sha256: digest, size: tar.length, files: 1 } },
    files: { 'tex/latex/base/foo.sty': 'core', [longName]: 'core' },
  }))
  self.onmessage({ data: { cmd: 'loadbundleindex', data: index.buffer, msgId: 1 } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(message(), {
    result: 'ok', cmd: 'loadbundleindex', msgId: 1, bundles: 1, files: 2, cached: 0, skipped: 0,
  })
  self.onmessage({ data: { cmd: 'preloadbundle', name: 'core', data: tarBuffer, msgId: 2 } })
  assert.deepEqual(message(), { result: 'ok', cmd: 'preloadbundle', msgId: 2, log: '' })

  const pointer = module._alloc(32)
  module.HEAPU8.set(new TextEncoder().encode('foo.sty\0'), pointer)
  const before = module.allocations.length
  const resolved = self.kpse_find_file_impl(pointer, 26, 1)
  assert.equal(module.UTF8ToString(resolved), '/texmf/tex/latex/base/foo.sty')
  const afterFirst = module.allocations.length
  assert.equal(afterFirst, before + 1, 'first resolver hit allocates one reusable result buffer')
  module.growMemory()
  assert.equal(module.UTF8ToString(resolved), '/texmf/tex/latex/base/foo.sty', 'resolver pointer survives heap growth')
  for (let i = 0; i < 20; i++) assert.equal(self.kpse_find_file_impl(pointer, 26, 1), resolved)
  assert.equal(module.allocations.length, afterFirst, 'repeated resolver hits reuse the result buffer')
  const longRequest = longName.split('/').pop()
  const longPointer = module._alloc(longRequest.length + 1)
  module.HEAPU8.set(new TextEncoder().encode(`${longRequest}\0`), longPointer)
  const grownResolved = self.kpse_find_file_impl(longPointer, 26, 1)
  assert.notEqual(grownResolved, 0, 'long indexed path resolves')
  assert.notEqual(grownResolved, resolved, 'a long path grows the resolver arena')
  assert.ok(module.deallocations.some(({ pointer }) => pointer === resolved),
    'growing the resolver arena releases the old allocation')
  assert.equal(message().cmd, 'resolver')
  messages.length = 0

  self.onmessage({ data: { cmd: 'writefile', url: 'main.tex', src: '\\documentclass{article}' } })
  assert.deepEqual(message(), { result: 'ok', cmd: 'writefile' })
  self.onmessage({ data: { cmd: 'writefile', url: 'img.png', src: new Uint8Array([0, 1, 2]) } })
  assert.deepEqual(message(), { result: 'ok', cmd: 'writefile' })
  self.onmessage({ data: { cmd: 'setmainfile', url: 'main.tex' } })
  self.onmessage({ data: { cmd: 'compilelatex' } })
  const compile = messages.shift()
  assert.equal(compile.result, 'ok')
  assert.equal(compile.cmd, 'compile')
  assert.match(compile.html, /data-latexml-css="latexml.css"/)
  assert.match(compile.html, /data-latexml-css="ltx-book.css"/)
  assert.match(compile.html, /data:image\/png;base64,AAEC/)
  assert.equal((compile.html.match(/data:image\/png;base64,AAEC/g) || []).length, 2,
    'project images in HTML and SVG xlink attributes are both inlined')
  assert.deepEqual(JSON.parse(JSON.stringify(compile.diagnostics)), [{ severity: 'warning', message: 'one recoverable warning' }])
  assert.equal(compile.log, 'one recoverable warning')
  assert.ok(module.deallocations.some(({ pointer, length }) => pointer === grownResolved && length > 0),
    'resolver result allocation is released after compile')

  const failurePointer = module._alloc(8)
  module.HEAPU8.set(new TextEncoder().encode('foo.sty\0'), failurePointer)
  const failureResolved = self.kpse_find_file_impl(failurePointer, 26, 1)
  messages.length = 0
  module._compile = () => { throw new Error('mock compiler failure') }
  self.onmessage({ data: { cmd: 'compilelatex' } })
  const failedCompile = messages.shift()
  assert.equal(failedCompile.result, 'failed')
  assert.ok(module.deallocations.some(({ pointer }) => pointer === failureResolved),
    'resolver result allocation is released after a failed compile')

  self.onmessage({ data: { cmd: 'readfile', url: 'main.tex', encoding: 'utf8' } })
  assert.deepEqual(message(), { result: 'ok', cmd: 'readfile', url: 'main.tex', data: '\\documentclass{article}' })
  self.onmessage({ data: { cmd: 'flushcache' } })
  assert.deepEqual(message(), { result: 'ok', cmd: 'flushcache' })
  assert.equal(module.files.size, 0)
  assert.equal(self.closed, undefined)
  console.log('latexml-worker: startup, bundle protocol, resolver arena, resource inlining, I/O, and flush checked')
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
