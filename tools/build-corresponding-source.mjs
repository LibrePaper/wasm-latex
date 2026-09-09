#!/usr/bin/env node
// Assemble the complete corresponding source for a distributed engine.
//
// GPL-2.0 section 3 conditions distribution of the binary on distributing the
// source it was built from. Not a link to someone's repository: the source, in
// the same place as the binary. For these engines that is
//
//   repo/            this repository at the commit that built the artifacts —
//                    Dockerfile, Makefile, C shims, worker controller, patches
//   texlive-source/  the pinned TeX Live tree, taken out of the build image, so
//                    it is the tree that actually compiled rather than a clone
//                    that ought to match. Contains kpathsea, zlib, libpng, xpdf,
//                    web2c, synctex and libmd5 — every statically linked
//                    component except the toolchain runtime.
//
// plus the manifest, rebuild and relink instructions. The Emscripten runtime
// pieces (musl, libc++, compiler-rt, dlmalloc) come from the digest-pinned
// emsdk image, which the manifest names exactly; their source is Emscripten's
// and is not vendored here.
//
//   node tools/build-corresponding-source.mjs --dist wasm-build/dist \
//     --image librepaper-pdftex-wasm --out dist-source/

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const distDir = path.resolve(arg('dist', 'wasm-build/dist'))
const image = arg('image', 'librepaper-pdftex-wasm')
const outDir = path.resolve(arg('out', 'dist-source'))
const keepStaging = process.argv.includes('--keep-staging')
const log = (...a) => console.error(...a)

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30, ...opts })

const commit = sh('git', ['rev-parse', 'HEAD']).trim()

// Dirty in the sense that matters: the archive's content comes from `git archive
// HEAD`, so the question is not whether the tree is tidy but whether anything
// that feeds a build differs from HEAD. A rewritten document cannot change a
// binary; an edited Makefile, shim or tool can, and then the archive would not
// be the source these artifacts came from.
const BUILD_PATHS = ['wasm-build/', 'tools/', 'linked-components.json']
const changed = sh('git', ['status', '--porcelain'])
  .split('\n').filter(Boolean).map((l) => l.slice(3).trim())
const buildChanges = changed.filter((f) => BUILD_PATHS.some((p) => f.startsWith(p)))
const dirty = buildChanges.length > 0
const texliveRef = fs.readFileSync('wasm-build/texlive-source-2026.ref', 'utf8').trim()
const release = `${commit.slice(0, 12)}${dirty ? '-dirty' : ''}`
const stem = `librepaper-wasm-latex-${release}-source`
const staging = path.join(outDir, stem)

if (dirty) {
  log('WARNING: uncommitted changes under a path that feeds the build:')
  for (const f of buildChanges) log(`           ${f}`)
  log('         The archive carries HEAD, so it would not be the source these')
  log('         artifacts were built from. Commit first.')
} else if (changed.length) {
  log(`note     ${changed.length} uncommitted change(s), none under ${BUILD_PATHS.join(', ')}`)
}

fs.rmSync(staging, { recursive: true, force: true })
fs.mkdirSync(staging, { recursive: true })

// --- This repository, at the commit that built the artifacts -----------------
log(`repo     ${commit}${dirty ? ' (dirty)' : ''}`)
fs.mkdirSync(path.join(staging, 'repo'))
sh('bash', ['-c', `git archive --format=tar HEAD | tar -x -C ${JSON.stringify(path.join(staging, 'repo'))}`])
if (dirty) {
  // Uncommitted changes are part of what built the binary, so they belong here.
  const diff = sh('git', ['diff', 'HEAD'])
  if (diff.trim()) fs.writeFileSync(path.join(staging, 'repo', 'UNCOMMITTED.patch'), diff)
}

// --- The TeX Live tree the binaries were compiled from ------------------------
log(`texlive  ${texliveRef} (from image ${image})`)
try {
  sh('bash', ['-c',
    `docker run --rm --platform linux/amd64 --entrypoint tar ${JSON.stringify(image)} ` +
    `-cf - --exclude=.git -C /src texlive-source | tar -x -C ${JSON.stringify(staging)}`])
} catch (error) {
  log(`\ncould not read the TeX Live tree out of image "${image}".`)
  log('Build it first, or pass --image with the tag you built:')
  log(`  docker buildx build --platform linux/amd64 --load --build-arg TEXLIVE_REF=${texliveRef} -t ${image} wasm-build/`)
  process.exit(1)
}
const configure = path.join(staging, 'texlive-source', 'configure')
if (!fs.existsSync(configure)) {
  log(`the image did not yield a TeX Live tree (no ${path.relative(staging, configure)})`)
  process.exit(1)
}

// --- What this source corresponds to ------------------------------------------
const artifacts = fs.existsSync(distDir)
  ? fs.readdirSync(distDir)
      // ICU data is compiled from libs/icu in the same tree, so it corresponds
      // to this source as much as a .wasm does.
      .filter((f) => /\.(wasm|js|fmt)$/.test(f) || /^icudt[0-9]+[lb]\.dat\.gz$/.test(f))
      .sort()
      .map((f) => {
        const data = fs.readFileSync(path.join(distDir, f))
        return { name: f, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
      })
  : []
if (!artifacts.length) log(`note: no artifacts found in ${distDir}; the manifest will name none`)

const inventories = fs.existsSync('receipts')
  ? fs.readdirSync('receipts').filter((f) => f.startsWith('LINK-INVENTORY.')).sort()
  : []

const manifest = {
  schemaVersion: 1,
  producedBy: 'tools/build-corresponding-source.mjs',
  repository: { commit, dirty, uncommittedBuildPaths: buildChanges, uncommittedOther: changed.length - buildChanges.length },
  texliveSource: { commit: texliveRef, repository: 'https://github.com/TeX-Live/texlive-source.git', path: 'texlive-source/' },
  toolchain: {
    emscripten: '3.1.46',
    dockerImage: 'emscripten/emsdk:3.1.46@sha256:2491bc4bf6caf8c41993660822341bc72759cb577363dfe0781f0a2d05f7d357',
    note: 'Runtime pieces linked from this image (musl libc, libc++, libc++abi, compiler-rt, dlmalloc) are Emscripten\'s; their source is at the pinned image digest and in the Emscripten project, and their notices are in repo/LICENSES/.',
  },
  correspondsTo: artifacts,
  linkInventories: inventories.map((f) => `repo/receipts/${f}`),
  terms: 'See repo/linked-components.json for the per-component basis and repo/THIRD_PARTY_NOTICES.md for the notices that must accompany the binaries.',
}
fs.writeFileSync(path.join(staging, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')

fs.copyFileSync('RELINK.md', path.join(staging, 'RELINK.md'))
fs.writeFileSync(path.join(staging, 'REBUILD.md'), `# Rebuilding these engines from this archive

Everything needed is here: this repository's build layer under \`repo/\`, and the
pinned TeX Live tree under \`texlive-source/\` — the tree the distributed binaries
were compiled from, taken out of the build image rather than cloned again.

    cp -r texlive-source repo/wasm-build/texlive-source
    docker buildx build --platform linux/amd64 --load \\
      --build-arg TEXLIVE_REF=${texliveRef} \\
      -t librepaper-pdftex-rebuild repo/wasm-build/
    docker run --rm --platform linux/amd64 -v "$PWD/out:/dist" librepaper-pdftex-rebuild

The Dockerfile uses a \`texlive-source/\` tree in its build context when one is
there, so the copy above is what makes the rebuild use this archive's source and
not the network. \`out/\` then holds the engine binaries.

Compare them with \`MANIFEST.json\`, which records the SHA-256 of every artifact
this source corresponds to:

    node repo/tools/link-inventory.mjs --root repo --dist out --family pdftex

The format file is built separately and is not linked code; see
\`repo/docs/format-generation.md\`.

To substitute your own copy of an LGPL library and relink, see \`RELINK.md\`.

Toolchain: Emscripten 3.1.46, image digest in \`MANIFEST.json\`. The build pulls
that exact digest, so a rebuild uses the same compiler.
`)

// --- Archive -------------------------------------------------------------------
const tarball = path.join(outDir, `${stem}.tar.xz`)
log('packing  (this takes a minute; the TeX Live tree is large)')
sh('bash', ['-c', `tar -cJf ${JSON.stringify(tarball)} -C ${JSON.stringify(outDir)} ${JSON.stringify(stem)}`])
if (!keepStaging) fs.rmSync(staging, { recursive: true, force: true })

const data = fs.readFileSync(tarball)
const sha = createHash('sha256').update(data).digest('hex')
fs.writeFileSync(`${tarball}.sha256`, `${sha}  ${path.basename(tarball)}\n`)

const receipt = {
  schemaVersion: 1,
  archive: path.basename(tarball),
  bytes: data.length,
  sha256: sha,
  repositoryCommit: commit,
  dirty,
  uncommittedBuildPaths: buildChanges,
  texliveSourceCommit: texliveRef,
  correspondsTo: artifacts,
}
fs.mkdirSync('receipts', { recursive: true })
fs.writeFileSync('receipts/SOURCE-RECEIPT.json', JSON.stringify(receipt, null, 2) + '\n')

log(`archive  ${path.relative(process.cwd(), tarball)}`)
log(`bytes    ${data.length}`)
log(`sha256   ${sha}`)
log(`receipt  receipts/SOURCE-RECEIPT.json`)
console.log(sha)
