import { expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDag } from './definition.js'
import { fixture, namedValue, profileSource, source } from './fixtures.js'
import {
  freezePlanRevision,
  parsePlan,
  resolvePlanAssignments,
} from './plan.js'
import { type Amendment, DefinitionError } from './schema.js'

const planSource = `schema: 1
kind: plan
name: composed
goal: Deliver reviewed reports then author the next step
criteria: {overall: Reports support the next decision}
context: Parent facts
defaults: {profile: reasoning, skills: [research]}
limits: {concurrency: 3, nodeRetries: 1, repairCycles: 2}
integration: {profile: reasoning}
review: {profile: reasoning}
verify: [{id: overall-check, argv: [bun, --version]}]
dags:
  first:
    file: parts/first.yaml
    satisfies: [overall]
  second:
    file: parts/second.yaml
    needs: [first]
    satisfies: [overall]
  later:
    needs: [second]
    satisfies: [overall]
    deferred:
      objective: Implement the reviewed findings
      decisionNeeded: Author the assignments from evidence
`
async function composedFixture() {
  const f = await fixture()
  await mkdir(join(f.root, 'plans/parts'), { recursive: true })
  const first = `${source.replace('skills: [research]', 'skills: []')}\nlimits: {concurrency: 9, nodeRetries: 0, repairCycles: 1}\n`
  const second = source
    .replace('defaults: {profile: coding, skills: [research]}\n', '')
    .replace(
      'review: {profile: reasoning}\n',
      'context: DAG facts\nlimits: {concurrency: 1}\n',
    )
    .replace('    task: Inspect', '    profile: coding\n    task: Inspect')
    .replace(
      'outputs: [findings.md]',
      'outputs: [findings.md]\n    write: [docs/]',
    )
  const documents = {
    'plans/plan.yaml': planSource,
    'plans/parts/first.yaml': first,
    'plans/parts/second.yaml': second,
    'profiles.yaml': profileSource,
  }
  for (const [path, content] of Object.entries(documents))
    await writeFile(join(f.root, path), content)
  await writeFile(
    join(f.root, 'review.md'),
    'Independent fixture review of all authored files and the deferred decision.',
  )
  const receipt = {
    verdict: 'approved',
    reviewerProfile: 'reasoning',
    evidencePath: 'review.md',
    documents: Object.entries(documents).map(([path, content]) => ({
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
    })),
  }
  await writeFile(
    join(f.root, 'plans/plan.review.json'),
    JSON.stringify(receipt),
  )
  return {
    ...f,
    paths: { ...f.paths, definitionPath: 'plans/plan.yaml' },
    documents,
    receipt,
  }
}
it('overall plan resolves ordinary DAG files with frozen reviewed defaults and explicit deferred context', async () => {
  const f = await composedFixture()
  try {
    const plan = await parsePlan(planSource, f.paths)
    const revision = await freezePlanRevision(plan, f)
    const first = namedValue(plan.dags, 'first')
    const second = namedValue(plan.dags, 'second')
    if (first?.kind !== 'file' || second?.kind !== 'file')
      throw new Error('Expected ordinary DAG entries')
    const standalone = parseDag(f.documents['plans/parts/first.yaml'], {
      ...f.paths,
      definitionPath: 'plans/parts/first.yaml',
    })
    expect(first.definition.nodes).toEqual(standalone.nodes)
    expect(first.file).toBe(join(f.root, 'plans/parts/first.yaml'))
    expect(first.definition.limits).toEqual({
      concurrency: 3,
      nodeRetries: 0,
      repairCycles: 1,
    })
    expect(standalone.limits.concurrency).toBe(9)
    expect(second.definition.limits).toEqual({
      concurrency: 1,
      nodeRetries: 1,
      repairCycles: 2,
    })
    expect(second).toMatchObject({ needs: ['first'], satisfies: ['overall'] })
    expect(second.definition.criteria).toEqual({
      proof: 'The output supports the goal',
    })
    expect(second.definition.stages).toEqual([
      'integration',
      'checks',
      'review',
    ])
    expect(plan.stages).toEqual(['checks', 'review'])
    expect(plan.limits).toEqual({
      concurrency: 3,
      nodeRetries: 1,
      repairCycles: 2,
    })
    expect(namedValue(plan.dags, 'later')).toEqual({
      kind: 'deferred',
      needs: ['second'],
      satisfies: ['overall'],
      deferred: {
        objective: 'Implement the reviewed findings',
        decisionNeeded: 'Author the assignments from evidence',
      },
    })
    expect(Object.keys(revision.assignments.dags)).toEqual(['first', 'second'])
    const firstSnapshots = namedValue(revision.assignments.dags, 'first')
    const secondSnapshots = namedValue(revision.assignments.dags, 'second')
    const firstProducer = namedValue(firstSnapshots?.nodes ?? {}, 'producer')
    const secondProducer = namedValue(secondSnapshots?.nodes ?? {}, 'producer')
    const consumer = namedValue(secondSnapshots?.nodes ?? {}, 'consumer')
    expect(firstProducer?.skills).toEqual([])
    expect(firstProducer?.profile?.model).toBe('local/small/model')
    expect(secondProducer?.skills.map((skill) => skill.name)).toEqual([
      'research',
    ])
    expect(secondProducer?.profile?.model).toBe('local/small/model')
    expect(secondProducer?.context).toBe('Parent facts\n\nDAG facts')
    expect(consumer?.skills).toEqual([])
    expect(consumer?.profile?.model).toBe('local/large')
    expect(
      Object.keys(plan.documents).sort((a, b) => a.localeCompare(b)),
    ).toEqual(
      Object.keys(f.documents)
        .map((path) => join(f.root, path))
        .sort((a, b) => a.localeCompare(b)),
    )
    await writeFile(
      join(f.root, 'plans/parts/first.yaml'),
      'edited after admission',
    )
    expect(plan.documents[first.file]?.content).toBe(
      f.documents['plans/parts/first.yaml'],
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
it.each([
  [
    'missing file',
    planSource.replace('parts/first.yaml', 'absent.yaml'),
    'resource',
  ],
  [
    'file and deferred',
    planSource.replace(
      '    file: parts/first.yaml',
      '    file: parts/first.yaml\n    deferred: {objective: Decide, decisionNeeded: Author}',
    ),
    'schema',
  ],
  [
    'cycle',
    planSource.replace(
      '    file: parts/first.yaml',
      '    file: parts/first.yaml\n    needs: [later]',
    ),
    'cycle',
  ],
  [
    'cross-DAG node edge',
    planSource.replace('needs: [first]', 'needs: [first.producer]'),
    'unknown-dependency',
  ],
  [
    'unknown criterion',
    planSource.replace('satisfies: [overall]', 'satisfies: [proof]'),
    'unknown-criterion',
  ],
  [
    'undelivered criterion',
    planSource.replaceAll('satisfies: [overall]', 'satisfies: []'),
    'undelivered-criterion',
  ],
  [
    'blank overall-check executable',
    planSource.replace(
      'argv: [bun, --version]',
      `argv: ${JSON.stringify([' \t ', 'argument'])}`,
    ),
    'schema',
  ],
  [
    'empty DAGs',
    `${planSource.slice(0, planSource.indexOf('dags:'))}dags: {}`,
    'empty-graph',
  ],
])(
  'invalid composition and deferred entries reject %s',
  async (_, input, code) => {
    const f = await composedFixture()
    try {
      await expect(parsePlan(input, f.paths)).rejects.toMatchObject({ code })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  },
)
it('composition rejects writes to another authored DAG', async () => {
  const f = await composedFixture()
  try {
    await writeFile(
      join(f.root, 'plans/parts/second.yaml'),
      f.documents['plans/parts/second.yaml'].replace(
        'write: [docs/]',
        'write: [plans/parts/first.yaml]',
      ),
    )
    await expect(parsePlan(planSource, f.paths)).rejects.toMatchObject({
      code: 'write-scope',
    })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
it('composition requires a large overall reviewer before execution', async () => {
  const f = await composedFixture()
  try {
    const plan = await parsePlan(
      planSource.replace(
        'review: {profile: reasoning}',
        'review: {profile: coding}',
      ),
      f.paths,
    )
    await expect(resolvePlanAssignments(plan, f)).rejects.toMatchObject({
      code: 'small-review',
    })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
it.each([
  ['incomplete parent/deferred review', 'coverage', 'review-coverage'],
  ['stale review', 'stale', 'review-identity'],
  ['duplicate document', 'duplicate', 'review-identity'],
  ['non-approval', 'verdict', 'plan-review'],
  ['small plan reviewer', 'small', 'plan-review'],
  ['empty evidence', 'evidence', 'review-evidence'],
  ['no implicit admission', 'missing', 'resource'],
])(
  'invalid composition and deferred entries prevent admission with %s',
  async (_, mode, code) => {
    const f = await composedFixture()
    try {
      const plan = await parsePlan(planSource, f.paths)
      let receipt = f.receipt
      switch (mode) {
        case 'coverage':
          receipt = { ...receipt, documents: receipt.documents.slice(1) }
          break
        case 'stale':
          receipt = {
            ...receipt,
            documents: receipt.documents.map((doc) => ({
              ...doc,
              sha256: 'a'.repeat(64),
            })),
          }
          break
        case 'duplicate':
          receipt = {
            ...receipt,
            documents: [...receipt.documents, ...receipt.documents],
          }
          break
        case 'verdict':
          receipt = { ...receipt, verdict: 'changes-requested' }
          break
        case 'small':
          receipt = { ...receipt, reviewerProfile: 'coding' }
          break
        case 'evidence':
          await writeFile(join(f.root, 'review.md'), '')
          break
        case 'missing':
          await rm(join(f.root, 'plans/plan.review.json'))
          break
        default:
          throw new Error('Unknown receipt case')
      }
      const error = await freezePlanRevision(plan, {
        ...f,
        ...(mode === 'missing'
          ? {}
          : { reviewSource: JSON.stringify(receipt) }),
      }).then(
        () => {
          throw new Error('Unreviewed plan admitted')
        },
        (error: unknown) => {
          if (error instanceof DefinitionError) return error
          throw error
        },
      )
      expect(error).toMatchObject({ code })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  },
)
it('overall plan resolves ordinary DAG files across minor clarifications and focused material approval', async () => {
  const f = await composedFixture()
  try {
    const original = await freezePlanRevision(
      await parsePlan(planSource, f.paths),
      f,
    )
    const clarifiedSource = planSource
      .replace('context: Parent facts', 'context: Clarified facts')
      .replace(
        'Reports support the next decision',
        'Reports substantiate the next decision',
      )
      .replace(
        'objective: Implement the reviewed findings',
        'objective: Implement using the reviewed findings',
      )
    const clarified = await parsePlan(clarifiedSource, f.paths)
    await rm(join(f.root, 'plans/plan.review.json'))
    const minor = await freezePlanRevision(clarified, {
      ...f,
      previous: original,
      amendment: {
        classification: 'minor',
        reason: 'Clarify existing context',
        changes: ['context', 'wording'],
      },
    })
    expect(minor.previous).toBe(original.id)
    expect(minor.id).not.toBe(original.id)
    expect(minor.review).toEqual(original.review)
    expect(minor.plan.context).toBe('Clarified facts')
    const changed = await parsePlan(
      clarifiedSource.replace('needs: [second]', 'needs: [first]'),
      f.paths,
    )
    const receipt = {
      ...f.receipt,
      documents: [
        {
          path: 'plans/plan.yaml',
          sha256: changed.documents[changed.path]?.sha256,
        },
      ],
    }
    const material = await freezePlanRevision(changed, {
      ...f,
      previous: minor,
      amendment: {
        classification: 'material',
        reason: 'Change checkpoint dependency',
        changes: ['dependencies'],
      },
      reviewSource: JSON.stringify(receipt),
    })
    expect(namedValue(material.plan.dags, 'later')?.needs).toEqual(['first'])
    expect(material.review.receipt.documents).toHaveLength(1)
    expect(material.previous).toBe(minor.id)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
it.each([
  ['unsupported material amendment', 'material', 'missing', 'resource'],
  ['incomplete material review', 'material', 'coverage', 'review-coverage'],
  ['minor misclassification', 'minor', 'changed', 'material-amendment'],
  ['semantic interface change', 'minor', 'interfaces', 'material-amendment'],
] as const)(
  'invalid composition and deferred entries reject %s',
  async (_, classification, mode, code) => {
    const f = await composedFixture()
    try {
      const previous = await freezePlanRevision(
        await parsePlan(planSource, f.paths),
        f,
      )
      const changed = await parsePlan(
        mode === 'interfaces'
          ? planSource
          : planSource.replace('needs: [second]', 'needs: [first]'),
        f.paths,
      )
      await rm(join(f.root, 'plans/plan.review.json'))
      const amendment: Amendment = {
        classification,
        reason: 'Revise checkpoint',
        changes: [mode === 'interfaces' ? 'interfaces' : 'context'],
      }
      await expect(
        freezePlanRevision(changed, {
          ...f,
          previous,
          amendment,
          ...(mode === 'coverage'
            ? {
                reviewSource: JSON.stringify({
                  ...f.receipt,
                  documents: f.receipt.documents.slice(1),
                }),
              }
            : {}),
        }),
      ).rejects.toMatchObject({ code })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  },
)

it('overall plan resolves ordinary DAG files with absent optional parent fields and default allowances', async () => {
  const f = await composedFixture()
  try {
    const input = planSource
      .replace('context: Parent facts\n', '')
      .replace('defaults: {profile: reasoning, skills: [research]}\n', '')
      .replace(
        'limits: {concurrency: 3, nodeRetries: 1, repairCycles: 2}\n',
        '',
      )
    const plan = await parsePlan(input, f.paths)
    const assignments = await resolvePlanAssignments(plan, f)
    expect(plan.limits).toEqual({
      concurrency: 1,
      nodeRetries: 2,
      repairCycles: 3,
    })
    const second = namedValue(plan.dags, 'second')
    if (second?.kind !== 'file') throw new Error('Missing second DAG')
    expect(second.definition.limits).toEqual({
      concurrency: 1,
      nodeRetries: 2,
      repairCycles: 3,
    })
    expect(
      namedValue(namedValue(assignments.dags, 'first')?.nodes ?? {}, 'producer')
        ?.context,
    ).toBe('')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
