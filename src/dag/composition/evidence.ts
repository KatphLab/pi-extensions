import * as fs from 'node:fs'
import type { ArtifactIdentity } from '@dag/command.js'
import { artifactIdentity } from '@dag/files.js'

export class CompositionError extends Error {
  constructor(
    readonly code: string,
    readonly resource: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: inspect ${resource}; composed work is retained`, options)
    this.name = 'CompositionError'
  }
}
export function identity(path: string): ArtifactIdentity {
  const result = artifactIdentity(path)
  if (!fs.lstatSync(path).isFile() || result.path !== path)
    throw new CompositionError('changed-evidence', path)
  return result
}
