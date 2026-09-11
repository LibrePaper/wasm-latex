import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const read = (file) => fs.readFileSync(file, 'utf8').trim()

// Return only complete, nonempty versioned snapshots. The build may opt out of
// dump generation while iterating; callers can then reject the empty result at
// release time without making the development receipt writer unusable.
export function collectKernelDumps(source) {
  const dumpsDir = path.join(source, 'resources', 'dumps')
  const dumpRecord = (file) => ({
    name: path.relative(source, file).split(path.sep).join('/'),
    bytes: fs.statSync(file).size,
    sha256: sha(file),
  })
  const years = new Set()
  if (fs.existsSync(dumpsDir)) {
    for (const name of fs.readdirSync(dumpsDir)) {
      const match = name.match(/^(?:plain|latex|texlive)\.(20\d\d)(?:\.dump\.txt|\.version)$/)
      if (match) years.add(Number(match[1]))
    }
  }
  return [...years].sort((a, b) => b - a).flatMap((year) => {
    const plainFile = path.join(dumpsDir, `plain.${year}.dump.txt`)
    const latexFile = path.join(dumpsDir, `latex.${year}.dump.txt`)
    const stampFile = path.join(dumpsDir, `texlive.${year}.version`)
    if (![plainFile, latexFile, stampFile].every((file) => fs.existsSync(file) && fs.statSync(file).size > 0)) return []
    return [{
      year,
      plain: dumpRecord(plainFile),
      latex: dumpRecord(latexFile),
      texlive: dumpRecord(stampFile),
      provenance: {
        kind: 'host-texlive-version-stamp',
        source: 'latexml-oxide/resources/dumps',
        version: read(stampFile),
      },
    }]
  })
}
