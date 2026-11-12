import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { join } from 'node:path'

export function approve(
  f: { readonly root: string },
  definition = 'dag.yaml',
  profiles = 'profiles.yaml',
) {
  const documents = (
    definition === 'plan.yaml'
      ? ['plan.yaml', 'dag.yaml', profiles]
      : ['dag.yaml', profiles]
  ).map((file) => {
    const path = join(f.root, file)
    return {
      path,
      sha256: createHash('sha256').update(fs.readFileSync(path)).digest('hex'),
    }
  })
  const receipt = {
    verdict: 'approved',
    reviewerProfile: 'large',
    documents,
    evidencePath: join(f.root, 'review.txt'),
  }
  const path = join(f.root, definition.replace('.yaml', '.review.json'))
  fs.writeFileSync(receipt.evidencePath, 'Independent review evidence')
  fs.writeFileSync(path, JSON.stringify(receipt))
  return { receipt, path }
}

export const dagSource = JSON.stringify({
  schema: 1,
  kind: 'dag',
  name: 'cli-unit',
  goal: 'Deliver a report',
  criteria: { proof: 'The report supports the goal' },
  review: { profile: 'large' },
  nodes: {
    build: {
      kind: 'agent',
      task: 'Produce the report',
      profile: 'large',
      satisfies: ['proof'],
      outputs: ['report.md'],
      references: ['input.txt'],
    },
  },
})
export const profileSource = JSON.stringify({
  profiles: {
    large: { model: 'unit/model:high', size: 'large' },
    small: { model: 'unit/model:high', size: 'small' },
  },
})
