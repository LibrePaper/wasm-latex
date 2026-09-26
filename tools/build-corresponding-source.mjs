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
//   latexml-oxide/   the exact latexml-oxide checkout named by
//                    latexml.build.json, plus native dependency source
//                    archives named by that receipt, and the Cargo crate
//                    archives named by its lock graph. TeX Live is only the
//                    kpathsea input for this engine; it is not its source.
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
import { normalizeCrateArchiveUrl } from './crate-url.mjs'

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
const BUILD_PATHS = ['wasm-build/', 'tools/', 'third-party/', 'Makefile', 'linked-components.json']
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

// --- LaTeXML's pinned source and native dependency sources -------------------
// LaTeXML is a separate Rust project with libxml2/libxslt and kpathsea inputs.
// Include those exact inputs when the release contains its build receipt; a
// TeX Live checkout by itself is not corresponding source for this engine.
let latexmlSource = null
const latexmlReceiptPath = path.join(distDir, 'latexml.build.json')
if (fs.existsSync(latexmlReceiptPath)) {
  const build = JSON.parse(fs.readFileSync(latexmlReceiptPath, 'utf8'))
  if (build.schemaVersion !== 1 || build.family !== 'latexml' ||
      !build.source?.repository || !/^[a-f0-9]{40}$/.test(build.source?.commit || '')) {
    throw new Error('latexml.build.json must pin a repository and 40-character commit')
  }
  const kernelDumpInput = path.join(distDir, 'latexml-kernels')
  if ((build.kernelDumps ?? []).length && !fs.existsSync(kernelDumpInput)) {
    throw new Error(`LaTeXML kernel dumps are present in the receipt but ${kernelDumpInput} is missing`)
  }
  const temp = fs.mkdtempSync(path.join(outDir, '.latexml-source-'))
  const checkout = path.join(temp, 'checkout')
  const sourceRoot = path.join(staging, 'latexml-oxide')
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.copyFileSync(latexmlReceiptPath, path.join(staging, 'latexml.build.json'))
  try {
    log(`latexml ${build.source.repository}@${build.source.commit}`)
    sh('git', ['clone', '--filter=blob:none', '--no-checkout', build.source.repository, checkout])
    sh('git', ['-C', checkout, 'checkout', '--detach', build.source.commit])
    const archive = execFileSync('git', ['-C', checkout, 'archive', '--format=tar', build.source.commit], {
      maxBuffer: 1 << 30,
      encoding: null,
    })
    execFileSync('tar', ['-x', '-C', sourceRoot], { input: archive, maxBuffer: 1 << 30 })

    // git archive deliberately omits generated resources/dumps. The build
    // driver stages receipt-listed snapshots beside the artifacts; copy those
    // exact files and verify every receipt byte before packaging source.
    for (const dump of build.kernelDumps ?? []) {
      for (const kind of ['plain', 'latex', 'texlive']) {
        const expectedName = kind === 'plain'
          ? `resources/dumps/plain.${dump.year}.dump.txt`
          : kind === 'latex'
            ? `resources/dumps/latex.${dump.year}.dump.txt`
            : `resources/dumps/texlive.${dump.year}.version`
        if (dump[kind]?.name !== expectedName) throw new Error(`LaTeXML kernel dump name mismatch: ${kind} ${dump.year}`)
        const input = path.join(kernelDumpInput, path.basename(expectedName))
        if (!fs.existsSync(input)) throw new Error(`LaTeXML kernel dump missing from ${kernelDumpInput}: ${path.basename(expectedName)}`)
        const bytes = fs.readFileSync(input)
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (bytes.length !== dump[kind].bytes || digest !== dump[kind].sha256) {
          throw new Error(`LaTeXML kernel dump does not match receipt: ${expectedName}`)
        }
        const output = path.join(sourceRoot, expectedName)
        fs.mkdirSync(path.dirname(output), { recursive: true })
        fs.writeFileSync(output, bytes)
      }
    }

    // LaTeXML pins kpathsea independently of the PDF engines. Include the
    // same sparse source selection used by its build driver.
    const kpse = (build.dependencies ?? []).find((dependency) => dependency.name === 'kpathsea')
    if (!kpse?.source || !/^[a-f0-9]{40}$/.test(kpse.version || '')) {
      throw new Error('LaTeXML receipt must pin the kpathsea source commit')
    }
    const kpseCheckout = path.join(temp, 'kpathsea')
    sh('git', ['init', '-q', kpseCheckout])
    sh('git', ['-C', kpseCheckout, 'remote', 'add', 'origin', kpse.source])
    sh('git', ['-C', kpseCheckout, 'sparse-checkout', 'init', '--cone'])
    sh('git', ['-C', kpseCheckout, 'sparse-checkout', 'set', 'texk/kpathsea', 'build-aux', 'm4'])
    sh('git', ['-C', kpseCheckout, 'fetch', '--depth', '1', '--filter=blob:none', 'origin', kpse.version])
    sh('git', ['-C', kpseCheckout, 'checkout', '--detach', 'FETCH_HEAD'])
    fs.cpSync(kpseCheckout, path.join(staging, 'latexml-kpathsea'), {
      recursive: true,
      filter: (entry) => path.basename(entry) !== '.git',
    })

    const dependencyRoot = path.join(staging, 'latexml-dependencies')
    for (const dependency of build.dependencies ?? []) {
      const archiveSpec = dependency.sourceArchive
      if (!archiveSpec?.url || !/^[a-f0-9]{64}$/.test(archiveSpec.sha256 || '')) continue
      fs.mkdirSync(dependencyRoot, { recursive: true })
      const archiveUrl = normalizeCrateArchiveUrl(archiveSpec.url)
      const filename = path.basename(new URL(archiveUrl).pathname) || `${dependency.name}-${dependency.version}.src`
      const destination = path.join(dependencyRoot, filename)
      log(`latexml dependency ${dependency.name} ${dependency.version}`)
      execFileSync('curl', ['-fL', '--retry', '3', '--output', destination, archiveUrl], { stdio: 'inherit' })
      const digest = createHash('sha256').update(fs.readFileSync(destination)).digest('hex')
      if (digest !== archiveSpec.sha256) throw new Error(`LaTeXML dependency archive hash mismatch: ${dependency.name}`)
    }
    const cargoRoot = path.join(staging, 'latexml-cargo')
    const cargoSources = []
    for (const packageInfo of build.cargo?.packages ?? []) {
      if (!packageInfo.name || !packageInfo.version ||
          !packageInfo.source?.startsWith('registry+') || !/^[a-f0-9]{64}$/.test(packageInfo.checksum || '')) continue
      fs.mkdirSync(cargoRoot, { recursive: true })
      const filename = `${packageInfo.name}-${packageInfo.version}.crate`
      const destination = path.join(cargoRoot, filename)
      // Use the registry's immutable archive host. The crates.io API download
      // endpoint is a redirect service and can be rejected by restricted
      // release environments even though the canonical crate is available.
      const url = `https://static.crates.io/crates/${packageInfo.name}/${packageInfo.name}-${packageInfo.version}.crate`
      log(`latexml cargo ${packageInfo.name} ${packageInfo.version}`)
      execFileSync('curl', ['-fL', '--retry', '3', '--output', destination, url], { stdio: 'inherit' })
      const digest = createHash('sha256').update(fs.readFileSync(destination)).digest('hex')
      if (digest !== packageInfo.checksum) throw new Error(`Cargo crate hash mismatch: ${packageInfo.name} ${packageInfo.version}`)
      cargoSources.push({ ...packageInfo, url, path: `latexml-cargo/${filename}` })
    }
    latexmlSource = {
      repository: build.source.repository,
      commit: build.source.commit,
      path: 'latexml-oxide/',
      kpathseaSource: { repository: kpse.source, commit: kpse.version, path: 'latexml-kpathsea/' },
      kernelDumps: build.kernelDumps ?? [],
      dependencies: (build.dependencies ?? []).map((dependency) => ({
        name: dependency.name,
        version: dependency.version,
        source: dependency.source,
        sourcePath: dependency.name === 'kpathsea' ? 'latexml-kpathsea/texk/kpathsea' : dependency.sourcePath ?? null,
        sourceArchive: dependency.sourceArchive ?? null,
        license: dependency.license,
        notices: dependency.notices ?? [],
      })),
      cargoSources,
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

// --- What this source corresponds to ------------------------------------------
const artifacts = fs.existsSync(distDir)
  ? fs.readdirSync(distDir)
      // ICU data is compiled from libs/icu in the same tree, so it corresponds
      // to this source as much as a .wasm does.
      .filter((f) => /\.(wasm|js|css|fmt)$/.test(f) || /^(biber|latexml)\.(data|build\.json)$/.test(f) || /^icudt[0-9]+[lb]\.dat\.gz$/.test(f))
      .sort()
      .map((f) => {
        const data = fs.readFileSync(path.join(distDir, f))
        return { name: f, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
      })
  : []
if (!artifacts.length) log(`note: no artifacts found in ${distDir}; the manifest will name none`)

let biberSource = null
if (artifacts.some(a => a.name === 'biber.wasm')) {
  const build = JSON.parse(fs.readFileSync(path.join(distDir, 'biber.build.json')))
  const source = fs.readFileSync(path.join(distDir, 'BIBER-SOURCE.tar.gz'))
  const digest = createHash('sha256').update(source).digest('hex')
  if (digest !== build.sourceArchive?.sha256) throw new Error('Biber source archive does not match its build receipt')
  for (const name of ['biber.js', 'biber.wasm', 'biber.data']) {
    if (artifacts.find(a => a.name === name)?.sha256 !== build.artifacts?.[name]?.sha256) throw new Error(`Biber source does not correspond to ${name}`)
  }
  fs.writeFileSync(path.join(staging, 'BIBER-SOURCE.tar.gz'), source)
  biberSource = { name: 'BIBER-SOURCE.tar.gz', sha256: digest, bytes: source.length }
}

const inventories = fs.existsSync('receipts')
  ? fs.readdirSync('receipts').filter((f) => f.startsWith('LINK-INVENTORY.')).sort()
  : []

const manifest = {
  biberSource,
  schemaVersion: 1,
  producedBy: 'tools/build-corresponding-source.mjs',
  repository: { commit, dirty, uncommittedBuildPaths: buildChanges, uncommittedOther: changed.length - buildChanges.length },
  texliveSource: { commit: texliveRef, repository: 'https://github.com/TeX-Live/texlive-source.git', path: 'texlive-source/' },
  latexmlSource,
  toolchain: {
    emscripten: '3.1.46',
    dockerImage: 'emscripten/emsdk:3.1.46@sha256:2491bc4bf6caf8c41993660822341bc72759cb577363dfe0781f0a2d05f7d357',
    note: 'Runtime pieces linked from this image (musl libc, libc++, libc++abi, compiler-rt, dlmalloc) are Emscripten\'s; their source is at the pinned image digest and in the Emscripten project, and their notices are in repo/LICENSES/.',
  },
  // LaTeXML is built by a separate Docker image because its Rust/LLVM output
  // requires a newer Emscripten SDK than the TeX engines.
  latexmlToolchain: {
    emscripten: '6.0.9',
    dockerImage: 'emscripten/emsdk:6.0.9@sha256:96617f27fe16421588241def73908fd348a7f9d260440ed0d00b36dcf7a063cc',
    rust: 'nightly-2026-08-02',
  },
  correspondsTo: artifacts,
  linkInventories: inventories.map((f) => `repo/receipts/${f}`),
  terms: 'See repo/linked-components.json for the per-component basis and repo/THIRD_PARTY_NOTICES.md for the notices that must accompany the binaries.',
}
fs.writeFileSync(path.join(staging, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')

fs.copyFileSync('RELINK.md', path.join(staging, 'RELINK.md'))
const latexmlRebuild = latexmlSource ? `
For a LaTeXML rebuild, first reconstruct a writable Git checkout at the exact
commit named by MANIFEST.json and latexml.build.json:

    mkdir -p rebuild out
    git clone --filter=blob:none --no-checkout \\
      ${JSON.stringify(latexmlSource.repository)} rebuild/latexml-oxide
    git -C rebuild/latexml-oxide checkout --detach \\
      ${latexmlSource.commit}
    docker buildx build --platform linux/amd64 --load \\
      -f repo/wasm-build/Dockerfile.latexml -t librepaper-latexml-rebuild repo/
    docker run --rm --platform linux/amd64 \\
      -e LATEXML_SOURCE_DIR=/latexml-oxide -e LATEXML_DIST_DIR=/dist \\
      -v "$PWD/rebuild/latexml-oxide:/latexml-oxide" \\
      -v "$PWD/out:/dist" librepaper-latexml-rebuild

The source checkout must be writable: the build generates format snapshots in
it, and the build script requires its .git directory to validate the pinned
commit. The archived latexml-oxide/ tree in this source bundle is retained
for audit and comparison, but is a git archive without .git and must not
be mounted as the build input. The latexml-kpathsea/ tree contains the separate
kpathsea revision recorded in the LaTeXML receipt, including its build-aux
and m4 inputs; the PDF engines use texlive-source/. The latexml-dependencies/ and
latexml-cargo/ files are verified source archives for audit or an offline
manual rebuild; the Docker build command fetches the receipt's pinned sources
from their declared URLs.
` : ''
fs.writeFileSync(path.join(staging, 'REBUILD.md'), `# Rebuilding these engines from this archive

Everything needed is here: this repository's build layer under \`repo/\`, and the
pinned source trees under \`texlive-source/\` and (when LaTeXML is present)
\`latexml-oxide/\`, \`latexml-dependencies/\`, and \`latexml-cargo/\`. TeX Live
is the tree the TeX engines were compiled from; LaTeXML has its own pinned Rust
source, native dependency archives, and Cargo crate sources recorded in
MANIFEST.json.

    cp -r texlive-source repo/wasm-build/texlive-source
    docker buildx build --platform linux/amd64 --load \\
      --build-arg TEXLIVE_REF=${texliveRef} \\
      -t librepaper-pdftex-rebuild repo/wasm-build/
    docker run --rm --platform linux/amd64 -v "$PWD/out:/dist" librepaper-pdftex-rebuild

The Dockerfile uses a \`texlive-source/\` tree in its build context when one is
there, so the copy above is what makes the rebuild use this archive's source and
not the network. \`out/\` then holds the engine binaries.

${latexmlRebuild}
The build uses Emscripten 6.0.9 and nightly Rust 2026-08-02, as recorded in
MANIFEST.json and \`latexml.build.json\`. Do not substitute the TeX Live tree
for the LaTeXML source.

Compare them with \`MANIFEST.json\`, which records the SHA-256 of every artifact
this source corresponds to:

    node repo/tools/link-inventory.mjs --root repo --dist out --family pdftex

The format file is built separately and is not linked code; see
\`repo/docs/format-generation.md\`.

To substitute your own copy of an LGPL library and relink, see \`RELINK.md\`.

When Biber is present, extract the embedded BIBER-SOURCE.tar.gz and follow
its README rebuild instructions. It contains the actual patched Perl/XS
sources and packaged modules and uses its separately pinned Emscripten 5.0.4
tooling image. See MANIFEST.json biberSource for the archive hash.

TeX toolchain: Emscripten 3.1.46, image digest in \`MANIFEST.json\`. The build pulls
that exact digest, so a rebuild uses the same compiler. LaTeXML uses its separate
Emscripten 6.0.9 image and nightly Rust pin recorded above.
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
  biberSource,
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
