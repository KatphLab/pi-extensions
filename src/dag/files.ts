import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

export function artifactIdentity(path: string) {
  const bytes = readFileSync(path)
  return Object.freeze({
    path: realpathSync(path),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  })
}

export function isWithin(root: string, path: string): boolean {
  const delta = relative(root, path)
  return (
    delta === '' ||
    (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`))
  )
}
