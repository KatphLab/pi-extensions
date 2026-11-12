import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dagSource } from '@dag/cli-test-fixture.js'
import { parseDag } from '@dag/definition/definition.js'
import { DefinitionError } from '@dag/definition/schema.js'
import { parseDocument } from 'yaml'
import { targetedReviewSource } from './review.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
function target(content: string) {
  const root = fs.mkdtempSync(join(tmpdir(), 'dag-review-target-'))
  roots.push(root)
  const path = join(root, 'target.yaml')
  fs.writeFileSync(path, content)
  return { root, path, profilesPath: join(root, 'profiles.yaml') }
}
const bundled = fs.readFileSync(
  new URL('./review-dag.yaml', import.meta.url),
  'utf8',
)

test('freezes target YAML and packaged benchmarks across projects without adopting execution authority', () => {
  const input = parseDocument(dagSource)
  input.setIn(['nodes', 'build', 'profile'], 'unconfigured-target-model')
  input.setIn(['nodes', 'build', 'skills'], ['unavailable-skill'])
  input.setIn(['nodes', 'build', 'write'], ['changed.txt'])
  input.set('integration', { profile: 'unconfigured-target-model' })
  input.set('verify', [{ id: 'target-check', argv: ['touch', 'changed.txt'] }])
  const content = input.toString()
  const f = target(content)
  // References, skills and model mappings need not exist to assess the YAML.
  const cwd = process.cwd()
  let source: string
  try {
    process.chdir(f.root)
    source = targetedReviewSource(bundled, f.path, f.profilesPath)
  } finally {
    process.chdir(cwd)
  }
  fs.writeFileSync(f.path, 'changed after capture')
  const paths = {
    projectRoot: f.root,
    definitionPath: join(f.root, 'review-dag.yaml'),
    profilesPath: f.profilesPath,
  }
  const review = parseDag(source, paths)
  const modelBenchmarksPath = fs.realpathSync(
    new URL(
      '../../../skills/writing-dags/references/model-benchmarks.md',
      import.meta.url,
    ),
  )
  const modelBenchmarksBytes = fs.readFileSync(modelBenchmarksPath)
  const context = review.context ?? ''
  const evidence = JSON.parse(context.slice(context.lastIndexOf('\n{')))
  expect(review.name).toBe('review-dag')
  expect(evidence).toEqual({
    target: {
      path: fs.realpathSync(f.path),
      sha256: createHash('sha256').update(content).digest('hex'),
      content,
    },
    modelBenchmarks: {
      path: modelBenchmarksPath,
      sha256: createHash('sha256').update(modelBenchmarksBytes).digest('hex'),
      content: modelBenchmarksBytes.toString('utf8'),
    },
  })
  expect(review.defaults).toMatchObject({ profile: 'large', skills: [] })
  expect(review.review).toMatchObject({ profile: 'large' })
  expect(review.integration).toBeUndefined()
  expect(review.verify).toEqual([])
  const outputs = new Set<string>()
  for (const node of Object.values(review.nodes)) {
    expect(node.kind).toBe('agent')
    expect(node.write).toEqual([])
    expect(node.references).toEqual([])
    expect(node.verify).toEqual([])
    for (const output of node.outputs) outputs.add(output)
  }
  expect(outputs).toEqual(
    new Set(['design.md', 'correctness.md', 'efficiency.md', 'review.md']),
  )
  expect(new Set(review.nodes['review']?.needs)).toEqual(
    new Set(['design', 'correctness', 'efficiency']),
  )
  expect(fs.existsSync(join(f.root, 'changed.txt'))).toBe(false)
})

test.each(['fragmented', 'justified', 'authoring/draft'])(
  'admits the %s evaluation subject without resolving or executing its external contracts',
  (name) => {
    const content = fs.readFileSync(
      new URL(`../../../evaluations/review-dag/${name}.yaml`, import.meta.url),
      'utf8',
    )
    const f = target(content)
    const review = parseDag(
      targetedReviewSource(bundled, f.path, f.profilesPath),
      {
        projectRoot: f.root,
        definitionPath: join(f.root, 'review-dag.yaml'),
        profilesPath: f.profilesPath,
      },
    )
    expect(review.name).toBe('review-dag')
    expect(fs.readdirSync(f.root)).toEqual(['target.yaml'])
  },
)

test.each([
  ['invalid YAML', 'kind: dag\nnodes: ['],
  ['ordinary YAML', 'hello: world'],
  ['a plan', 'schema: 1\nkind: plan'],
  [
    'a cyclic DAG',
    dagSource.replace('"references":', '"needs":["build"],"references":'),
  ],
  [
    'uncovered criteria',
    dagSource.replace('"satisfies":["proof"]', '"satisfies":[]'),
  ],
])('rejects %s instead of submitting it for review', (_label, content) => {
  const f = target(content)
  expect(() => targetedReviewSource(bundled, f.path, f.profilesPath)).toThrow(
    DefinitionError,
  )
  expect(fs.readFileSync(f.path, 'utf8')).toBe(content)
})
