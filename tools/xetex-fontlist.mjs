#!/usr/bin/env node
// Build xetexfontlist.txt, the by-name font database fontconfig-shim.c's
// FcFontList() answers XeTeX's font manager entirely from (kpse format 26,
// name "xetexfontlist.txt") - there is no per-font filesystem scan under the
// on-demand WASM model. No such file ships in TeX Live; it is generated here,
// at build time, from every OpenType/TrueType font in the texmf trees, using
// `otfinfo` (a build-machine tool - this never runs inside the engine
// sandbox). Format is documented in fontconfig-shim.c: one font per record,
// one field per line:
//   fontId / file / index / N family-lines / N style-lines / N fullname-lines /
//   psName / subFamily / weight / width / slant / isReg / isBold / isItalic /
//   designSize / minSize / maxSize / subFamilyID / subFamilyID(dup)
// weight/width/slant use the fontconfig integer scale the shim's header defines
// (FC_WEIGHT_REGULAR=80/FC_WEIGHT_BOLD=200, FC_WIDTH_NORMAL=100,
// FC_SLANT_ROMAN=0/FC_SLANT_ITALIC=100) - good enough for XeTeX's matcher to
// pick the right shape when a family has regular/bold/italic/bolditalic members.
//
// Used by tools/build-format.mjs (in-process, to answer the format build's own
// kpse format-26 request) and by the CLI below (to produce the copy that ships
// as a bundle member, tex/xetex/fontlist/xetexfontlist.txt - see docs/bundles.md
// and tools/build-bundles.mjs's --extra flag).
//
//   node tools/xetex-fontlist.mjs --texmf <dir> [--texmf <dir> ...] \
//     [--out wasm-build/dist/xetexfontlist.txt]
//
// Deterministic: fonts are sorted by texmf-relative path before otfinfo runs,
// and the output carries no timestamp.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export function buildXetexFontList(texmfDirs, { log = () => {} } = {}) {
  const fontFiles = []
  for (const [root, dir] of texmfDirs.entries()) {
    for (const kind of ['opentype', 'truetype']) {
      const base = path.join(dir, 'fonts', kind)
      if (!fs.existsSync(base)) continue
      ;(function walk(current) {
        let entries
        try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const full = path.join(current, e.name)
          if (e.isDirectory()) { walk(full); continue }
          if (!e.isFile()) continue
          if (!/\.(otf|ttf|ttc)$/i.test(e.name)) continue
          fontFiles.push({ root, full, rel: path.relative(dir, full), base: e.name })
        }
      })(base)
    }
  }
  fontFiles.sort((a, b) => a.rel.localeCompare(b.rel))

  const lines = []
  let fontId = 0
  let ok = 0
  let skipped = 0
  for (const f of fontFiles) {
    let info
    try {
      info = execFileSync('otfinfo', ['-i', f.full], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      skipped++
      continue
    }
    const get = (label) => {
      const m = new RegExp(`^${label}:\\s*(.+)$`, 'm').exec(info)
      return m ? m[1].trim() : null
    }
    const family = get('Family')
    const subfamily = get('Subfamily') || 'Regular'
    const fullname = get('Full name')
    const psName = get('PostScript name') || ''
    const prefFamily = get('Preferred family')
    const prefSubfamily = get('Preferred subfamily')
    if (!family) { skipped++; continue }

    const families = [...new Set([family, prefFamily].filter(Boolean))]
    const styles = [...new Set([subfamily, prefSubfamily].filter(Boolean))]
    const fullnames = [...new Set([fullname, psName].filter(Boolean))]

    const lower = `${subfamily} ${prefSubfamily || ''}`.toLowerCase()
    const isBold = /bold/.test(lower)
    const isItalic = /italic|oblique/.test(lower)
    const weight = isBold ? 200 : 80        // FC_WEIGHT_BOLD / FC_WEIGHT_REGULAR
    const width = 100                       // FC_WIDTH_NORMAL
    const slant = isItalic ? 100 : 0        // FC_SLANT_ITALIC / FC_SLANT_ROMAN

    lines.push(
      String(fontId++),
      f.base,                 // file: bare name, resolved later via kpse by extension
      '0',                    // index (no .ttc face selection here)
      String(families.length), ...families,
      String(styles.length), ...styles,
      String(fullnames.length), ...fullnames,
      psName,
      subfamily,
      String(weight), String(width), String(slant),
      isBold || isItalic ? '0' : '1',   // isReg
      isBold ? '1' : '0',               // isBold
      isItalic ? '1' : '0',             // isItalic
      '10', '0', '0',                   // designSize, minSize, maxSize (unused by the shim's matcher)
      '0', '0',                         // subFamilyID, subFamilyID(dup)
    )
    ok++
  }
  log(`xetexfontlist ${ok} fonts indexed, ${skipped} skipped (no otfinfo metadata), ${fontFiles.length} font files found`)
  return `${lines.join('\n')}\n`
}

// --- CLI -----------------------------------------------------------------------

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`
}

if (isMain()) {
  function argAll(name) {
    const out = []
    process.argv.forEach((a, i) => { if (a === `--${name}`) out.push(process.argv[i + 1]) })
    return out
  }
  function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
  }

  const texmfDirs = argAll('texmf').filter(Boolean).map((d) => path.resolve(d))
  const outPath = path.resolve(arg('out', 'wasm-build/dist/xetexfontlist.txt'))

  if (!texmfDirs.length || texmfDirs.some((d) => !fs.existsSync(d))) {
    console.error('usage: node tools/xetex-fontlist.mjs --texmf <dir> [--texmf <dir> ...] [--out file]')
    process.exit(2)
  }

  const text = buildXetexFontList(texmfDirs, { log: (...a) => console.error(...a) })
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, text)
  console.error(`wrote ${path.relative(process.cwd(), outPath)}`)
}
