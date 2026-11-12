import { expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DefaultResourceLoader,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import {
  parseDag,
  resolveAssignments,
  resolveContextIndex,
  validateReferences,
} from './definition.js'
import { fixture, namedValue, profileSource, source } from './fixtures.js'
import { resolveProfileModel } from './model.js'
import {
  DefinitionError,
  parsePlanReviewReceipt,
  parseProfiles,
  parseReviewReport,
  parseWorkerReport,
} from './schema.js'

function errorOf(action: () => unknown): DefinitionError {
  try {
    action()
  } catch (error) {
    if (error instanceof DefinitionError) return error
    throw error
  }
  throw new Error('Invalid input was accepted')
}
it.each(['', ':high'])(
  'valid standalone definitions resolve exact profiles %s, replaced skill lists and frozen resource snapshots',
  async (suffix) => {
    const f = await fixture()
    try {
      const dag = parseDag(source, f.paths)
      const result = await resolveAssignments(dag, {
        ...f,
        profiles: parseProfiles(
          profileSource
            .replace('local/small/model', `local/small/model${suffix}`)
            .replace('local/large', `local/large${suffix}`),
        ),
      })
      expect(Object.keys(result.nodes)).toEqual([
        'producer',
        'consumer',
        'command',
      ])
      const producer = Object.values(result.nodes).find(
        (node) => node.id === 'producer',
      )
      expect(producer?.profile?.model).toBe(`local/small/model${suffix}`)
      expect(producer?.node.outputs).toEqual(['findings.md'])
      expect(
        producer?.skills.map((skill) => [skill.name, skill.baseDir]),
      ).toEqual([['research', join(f.root, 'research')]])
      const consumer = Object.values(result.nodes).find(
        (node) => node.id === 'consumer',
      )
      const command = Object.values(result.nodes).find(
        (node) => node.id === 'command',
      )
      expect(consumer?.skills).toEqual([])
      expect(consumer?.profile?.model).toBe(`local/large${suffix}`)
      expect(command?.profile).toBeUndefined()
      expect(producer?.instructions.map((file) => file.path)).toContain(
        join(f.root, 'AGENTS.md'),
      )
      await writeFile(
        join(f.root, 'research/SKILL.md'),
        'Changed after resolution',
      )
      expect(producer?.skills[0]?.content).toBe(
        '---\nname: research\ndescription: Inspect local evidence\n---\nUse the fixture facts.\n',
      )
      expect(dag.limits).toEqual({
        concurrency: 1,
        nodeRetries: 2,
        repairCycles: 3,
      })
      expect(dag.stages).toEqual(['checks', 'review'])
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  },
)
it('exact profile model references preserve literal colon IDs and recognize only final thinking suffixes', async () => {
  const f = await fixture()
  try {
    const base = f.modelRuntime.getPhysicalModel('local', 'large')
    if (!base) throw new Error('Missing fixture model')
    f.modelRuntime.registerProvider('literal', {
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'fixture-only',
      models: ['nested/model:high', 'nested/model:exacto'].map((id) => ({
        ...base,
        id,
        name: id,
      })),
    })
    for (const [reference, modelId, thinkingLevel] of [
      ['literal/nested/model:high', 'nested/model:high', 'off'],
      ['literal/nested/model:high:low', 'nested/model:high', 'low'],
      ['literal/nested/model:exacto:high', 'nested/model:exacto', 'high'],
    ] as const) {
      expect(resolveProfileModel(reference, f.modelRuntime)).toMatchObject({
        provider: 'literal',
        modelId,
        model: { id: modelId },
        thinkingLevel,
      })
    }
    for (const level of [
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]) {
      expect(
        resolveProfileModel(`local/large:${level}`, f.modelRuntime),
      ).toMatchObject({
        provider: 'local',
        modelId: 'large',
        model: { id: 'large' },
        thinkingLevel: level,
      })
    }
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
it('valid standalone definitions integrate documentation writes and accept zero retry allowances', async () => {
  const f = await fixture()
  try {
    const dag = parseDag(
      `${source.replace('outputs: [findings.md]', 'outputs: [findings.md]\n    write: [docs/]')}\nintegration: {profile: coding}\nlimits: {concurrency: 1, nodeRetries: 0, repairCycles: 0}\n`,
      f.paths,
    )
    expect(dag.stages).toEqual(['integration', 'checks', 'review'])
    expect(dag.limits).toEqual({
      concurrency: 1,
      nodeRetries: 0,
      repairCycles: 0,
    })
    const result = await resolveAssignments(dag, {
      ...f,
      profiles: parseProfiles(profileSource),
    })
    expect(result.integration?.size).toBe('small')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
it('literal argv preserves empty and whitespace positional arguments in commands and checks', async () => {
  const f = await fixture()
  try {
    const argv = ['bun', '', ' \t ']
    const check = { id: 'literal', argv }
    const dag = parseDag(
      `${source
        .replace('argv: [bun, --version]', `argv: ${JSON.stringify(argv)}`)
        .replace(
          'outputs: [findings.md]',
          `outputs: [findings.md]\n    verify: ${JSON.stringify([check])}`,
        )}\nverify: ${JSON.stringify([check])}\n`,
      f.paths,
    )
    expect(namedValue(dag.nodes, 'command')).toMatchObject({ argv })
    expect(namedValue(dag.nodes, 'producer')?.verify).toEqual([check])
    expect(dag.verify).toEqual([check])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
const invalid: readonly (readonly [
  string,
  string,
  string | { readonly code: string; readonly field: string },
])[] = [
  [
    'removed artifact contracts',
    source.replace(
      '    outputs: [findings.md]',
      '    outputs: [findings.md]\n    artifactContracts: {"findings.md":{"headings":["Findings"]}}',
    ),
    'schema',
  ],
  [
    'duplicate key',
    source.replace('    kind: agent', '    kind: agent\n    kind: agent'),
    'DUPLICATE_KEY',
  ],
  [
    'cycle',
    source.replace(
      '    satisfies: [proof]',
      '    needs: [consumer]\n    satisfies: [proof]',
    ),
    'cycle',
  ],
  [
    'prototype dependency',
    source.replace('needs: [producer]', 'needs: [constructor]'),
    'unknown-dependency',
  ],
  [
    'criterion',
    source.replace('satisfies: [proof]', 'satisfies: [missing]'),
    'unknown-criterion',
  ],
  [
    'undelivered',
    source.replace('satisfies: [proof]', 'satisfies: []'),
    'undelivered-criterion',
  ],
  [
    'missing evidence',
    source.replace('    outputs: [findings.md]\n', ''),
    'unproven-claim',
  ],
  [
    'integration',
    source.replace(
      'outputs: [findings.md]',
      'outputs: [findings.md]\n    write: [README.md]',
    ),
    'integration-profile',
  ],
  ['unknown field', `${source}\nextra: true`, 'schema'],
  [
    'missing frozen context lookup',
    source.replace(
      '    task: Consume the report',
      '    requiredContext: [agreedPlan]\n    task: Consume the report',
    ),
    'context-reference',
  ],
  [
    'blank command executable',
    source.replace(
      'argv: [bun, --version]',
      `argv: ${JSON.stringify([' \t ', 'argument'])}`,
    ),
    'schema',
  ],
  [
    'blank node-check executable',
    source.replace(
      'outputs: [findings.md]',
      `outputs: [findings.md]\n    verify: [{id: check, argv: ${JSON.stringify([' \t ', 'argument'])}}]`,
    ),
    'schema',
  ],
  [
    'blank final-check executable',
    `${source}\nverify: [{id: check, argv: ${JSON.stringify([' \t ', 'argument'])}}]`,
    'schema',
  ],
  ['plan', source.replace('kind: dag', 'kind: plan'), 'unsupported-plan'],
  ['extra document', `${source}\n---\nkind: dag`, 'MULTIPLE_DOCS'],
  [
    'alias',
    source.replace(
      'skills: []',
      'skills: &policy [research]\n    references: *policy',
    ),
    'alias',
  ],
  [
    'unsafe ID',
    source.replace('  producer:', '  ../maker:'),
    { code: 'schema', field: 'nodes/../maker' },
  ],
  ...['node.lock', 'a..b'].map(
    (
      name,
    ): readonly [
      string,
      string,
      { readonly code: string; readonly field: string },
    ] => [
      `invalid Git ref node ${name}`,
      source.replace('  producer:', `  ${name}:`),
      { code: 'schema', field: `nodes/${name}` },
    ],
  ),
  [
    'duplicate checks',
    `${source}\nverify: [{id: check, argv: [bun]}, {id: check, argv: [bun]}]`,
    'duplicate-check',
  ],
  ...['runner/result', '../escape'].map(
    (path): readonly [string, string, string] => [
      `output ${path}`,
      source.replace('outputs: [findings.md]', `outputs: [${path}]`),
      path.startsWith('.') ? 'path' : 'reserved-output',
    ],
  ),
  ...[
    '../escape',
    '/absolute',
    'src/*.ts',
    'nested/.git/config',
    '.pi/dags/runs/leak',
    'profiles.yaml',
  ].map((path): readonly [string, string, string] => [
    `write ${path}`,
    source.replace(
      'outputs: [findings.md]',
      `outputs: [findings.md]\n    write: [${JSON.stringify(path)}]`,
    ),
    path.includes('..') || path.startsWith('/') || path.includes('*')
      ? 'path'
      : 'write-scope',
  ]),
  ['zero concurrency', `${source}\nlimits: {concurrency: 0}`, 'schema'],
  [
    'negative retry allowance',
    `${source}\nlimits: {nodeRetries: -1}`,
    'schema',
  ],
] as const
it.each(invalid)(
  'invalid standalone definitions reject %s',
  async (_, input, expected) => {
    const f = await fixture()
    try {
      const error = errorOf(() => parseDag(input, f.paths))
      expect(error).toMatchObject(
        typeof expected === 'string' ? { code: expected } : expected,
      )
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  },
)
it('invalid standalone definitions reject existing directory write scopes without a trailing slash', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, 'src'))
    const input = `${source.replace('outputs: [findings.md]', 'outputs: [findings.md]\n    write: [src]')}\nintegration: {profile: coding}`
    expect(errorOf(() => parseDag(input, f.paths))).toMatchObject({
      code: 'write-scope',
      field: 'write',
    })
    expect(
      parseDag(input.replace('write: [src]', 'write: [src/]'), f.paths),
    ).toMatchObject({ nodes: { producer: { write: ['src/'] } } })
    expect(
      parseDag(input.replace('write: [src]', 'write: [src/new.ts]'), f.paths),
    ).toMatchObject({ nodes: { producer: { write: ['src/new.ts'] } } })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
it('invalid standalone definitions reject symlink escapes and ancestor scopes protecting authored inputs', async () => {
  const f = await fixture()
  try {
    await symlink(join(f.root, '..'), join(f.root, 'escape'))
    await mkdir(join(f.root, 'plans'))
    await writeFile(join(f.root, 'plans/dag.yaml'), source)
    expect(
      errorOf(() =>
        parseDag(
          source.replace(
            'outputs: [findings.md]',
            'outputs: [findings.md]\n    write: [plans/]',
          ),
          { ...f.paths, definitionPath: 'plans/dag.yaml' },
        ),
      ).code,
    ).toBe('write-scope')
    const input = `${source.replace('outputs: [findings.md]', 'outputs: [findings.md]\n    write: [escape/new.md]')}\nintegration: {profile: coding}`
    expect(errorOf(() => parseDag(input, f.paths)).code).toBe('write-scope')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
it.each([
  [
    'skill',
    source.replace('skills: [research]', 'skills: [absent]'),
    profileSource,
    'required-skill',
  ],
  [
    'model',
    source,
    profileSource.replace('local/small/model', 'local/absent'),
    'unavailable-model',
  ],
  [
    'unknown thinking suffix',
    source,
    profileSource.replace('local/large', 'local/large:ultra'),
    'unavailable-model',
  ],
  [
    'fuzzy model with thinking suffix',
    source,
    profileSource.replace('local/large', 'local/larg:high'),
    'unavailable-model',
  ],
  [
    'small review',
    source,
    profileSource.replace('size: large', 'size: small'),
    'small-review',
  ],
  [
    'profile',
    source.replace('profile: coding', 'profile: absent'),
    profileSource,
    'missing-profile',
  ],
])(
  'invalid standalone definitions reject unavailable %s before execution',
  async (_, input, profiles, code) => {
    const f = await fixture()
    try {
      await expect(
        resolveAssignments(parseDag(input, f.paths), {
          ...f,
          profiles: parseProfiles(profiles),
        }),
      ).rejects.toMatchObject({ code })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  },
)
it('valid standalone definitions defer reference existence until prerequisite preparation', async () => {
  const f = await fixture()
  try {
    const dag = parseDag(
      source.replace(
        'needs: [producer]',
        'needs: [producer]\n    references: [generated.md]',
      ),
      f.paths,
    )
    const node = Object.entries(dag.nodes).find(
      ([name]) => name === 'consumer',
    )?.[1]
    if (!node) throw new Error('Missing consumer')
    await expect(validateReferences(node, f.root)).rejects.toMatchObject({
      code: 'resource',
    })
    await writeFile(join(f.root, 'generated.md'), 'Accepted producer result')
    await validateReferences(node, f.root)
    const plan = join(f.root, 'frozen-plan.md')
    const content = '# Agreed\nRequired frozen behavior\n'
    await writeFile(plan, content)
    const pin = {
      path: plan,
      sha256: createHash('sha256').update(content).digest('hex'),
      sections: ['Agreed'],
    }
    const indexed = {
      ...node,
      references: [],
      requiredContext: ['agreedPlan'],
      contextIndex: { agreedPlan: pin },
    }
    expect(
      await resolveContextIndex(indexed, join(f.root, 'research')),
    ).toEqual({
      agreedPlan: pin,
    })
    await expect(
      validateReferences({ ...indexed, requiredContext: ['missing'] }, f.root),
    ).rejects.toMatchObject({
      code: 'context-reference',
      field: 'requiredContext/missing',
      message: 'Missing frozen context lookup: missing',
    })
    await expect(
      validateReferences(
        {
          ...indexed,
          contextIndex: {
            agreedPlan: { ...pin, path: join(f.root, 'absent-plan.md') },
          },
        },
        f.root,
      ),
    ).rejects.toThrow(
      `Required frozen context agreedPlan is unavailable: ${join(f.root, 'absent-plan.md')}`,
    )
    await expect(
      validateReferences(
        {
          ...indexed,
          contextIndex: { agreedPlan: { ...pin, sections: ['Missing'] } },
        },
        f.root,
      ),
    ).rejects.toThrow('Frozen context agreedPlan is missing section "Missing"')
    const relative = {
      ...indexed,
      contextIndex: { agreedPlan: { ...pin, path: 'frozen-plan.md' } },
    }
    await expect(validateReferences(relative, f.root)).rejects.toThrow(
      'must name a declared reference',
    )
    expect(
      await resolveContextIndex(
        { ...relative, references: ['frozen-plan.md'] },
        f.root,
      ),
    ).toEqual({ agreedPlan: pin })
    await writeFile(plan, '# Agreed\nChanged after admission\n')
    await expect(validateReferences(indexed, f.root)).rejects.toThrow(
      `Frozen context agreedPlan changed: ${plan}`,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
it('valid standalone definitions parse bounded worker, review and author-review reports without trusting completion', () => {
  const worker = {
    outcome: 'claimed-complete' as const,
    summary: 'Delivered report',
    deliverables: ['findings.md'],
    evidence: [{ criterion: 'proof', paths: ['findings.md'] }],
    findings: [],
  }
  expect(parseWorkerReport(JSON.stringify(worker))).toEqual(worker)
  expect(
    parseReviewReport(
      JSON.stringify({
        verdict: 'approved',
        summary: 'Supported',
        findings: [],
      }),
    ).verdict,
  ).toBe('approved')
  expect(
    parsePlanReviewReceipt(
      JSON.stringify({
        verdict: 'approved',
        reviewerProfile: 'reasoning',
        documents: [{ path: 'dag.yaml', sha256: 'a'.repeat(64) }],
        evidencePath: 'review.md',
      }),
    ).reviewerProfile,
  ).toBe('reasoning')
  expect(
    errorOf(() =>
      parseWorkerReport(JSON.stringify({ ...worker, outcome: 'succeeded' })),
    ).code,
  ).toBe('schema')
  expect(errorOf(() => parseWorkerReport('x'.repeat(32_769))).code).toBe(
    'oversize-report',
  )
  expect(errorOf(() => parseReviewReport('{bad json')).code).toBe('report-json')
})
it('invalid standalone definitions reject an existing exact model without authenticated availability', async () => {
  const f = await fixture(false)
  try {
    expect(f.modelRuntime.getPhysicalModel('local', 'small/model')?.id).toBe(
      'small/model',
    )
    await expect(
      resolveAssignments(parseDag(source, f.paths), {
        ...f,
        profiles: parseProfiles(profileSource),
      }),
    ).rejects.toMatchObject({ code: 'unavailable-model' })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
it('invalid standalone definitions reject ambiguous selected skills from actual SDK discovery', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, 'duplicate'))
    await writeFile(
      join(f.root, 'duplicate/SKILL.md'),
      '---\nname: research\ndescription: Duplicate required skill\n---\nDifferent instructions.\n',
    )
    const resources = new DefaultResourceLoader({
      cwd: f.root,
      agentDir: join(f.root, 'agent'),
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [
        join(f.root, 'research'),
        join(f.root, 'duplicate'),
      ],
    })
    const loading: Promise<void> = resources.reload()
    await loading
    await expect(
      resolveAssignments(parseDag(source, f.paths), {
        ...f,
        resources,
        profiles: parseProfiles(profileSource),
      }),
    ).rejects.toMatchObject({ code: 'required-skill' })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
