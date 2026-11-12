import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { isWithin } from '@dag/files.js'
import type {
  ModelRuntime,
  ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import { resolveProfileModel } from './model.js'
import {
  type AssignmentSnapshots,
  type DagDefinition,
  type DagNode,
  DefinitionError,
  type DefinitionPaths,
  dagSchema,
  type EffectiveAssignment,
  identifier,
  type Profile,
  type Profiles,
  parse,
  type SkillSnapshot,
  text,
  uniqueChecks,
  validateCoverage,
  validateGraph,
  yaml,
} from './schema.js'

function literalPath(value: string, field: string): string {
  const segments = value.replace(/\/$/, '').split('/')
  if (
    isAbsolute(value) ||
    value.includes('\\') ||
    /[*?[\]{}]/.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32) ||
    segments.some((part) => !part || part === '.' || part === '..')
  )
    throw new DefinitionError(
      'path',
      field,
      'Use a literal project-relative path without traversal or globs',
    )
  return segments.join('/')
}
export function existingAncestor(path: string): string {
  try {
    lstatSync(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return resolve(
        existingAncestor(dirname(path)),
        relative(dirname(path), path),
      )
    throw new DefinitionError(
      'filesystem',
      path,
      'Cannot resolve path ancestor',
      { cause: error instanceof Error ? error : new Error(String(error)) },
    )
  }
  try {
    return realpathSync(path)
  } catch (error) {
    throw new DefinitionError(
      'filesystem',
      path,
      'Cannot resolve existing path',
      { cause: error instanceof Error ? error : new Error(String(error)) },
    )
  }
}
function writePath(value: string, paths: DefinitionPaths): void {
  const clean = literalPath(value, 'write')
  const root = realpathSync(paths.projectRoot)
  const target = existingAncestor(resolve(root, clean))
  const protectedPaths = [
    '.git',
    '.pi/dags/runs',
    '.pi/dags/wt',
    paths.definitionPath,
    paths.profilesPath,
    ...(paths.authoredPaths ?? []),
  ].map((path) => existingAncestor(resolve(root, path)))
  if (
    clean.split('/').includes('.git') ||
    !isWithin(root, target) ||
    protectedPaths.some(
      (path) =>
        isWithin(path, target) ||
        (value.endsWith('/') && isWithin(target, path)),
    )
  )
    throw new DefinitionError(
      'write-scope',
      'write',
      'Write scope overlaps a protected path or escapes the project',
    )
  if (
    !value.endsWith('/') &&
    lstatSync(target, { throwIfNoEntry: false })?.isDirectory()
  )
    throw new DefinitionError(
      'write-scope',
      'write',
      'Directory write scopes must end with /',
    )
}
function outputPath(value: string): void {
  const clean = literalPath(value, 'outputs')
  if (
    value.endsWith('/') ||
    clean
      .split('/')
      .some((part) =>
        ['runner', 'outcome.json', 'handoff.md', 'review.json'].includes(part),
      )
  )
    throw new DefinitionError(
      'reserved-output',
      'outputs',
      'Output collides with runner/control records',
    )
}
function validateNode(
  input: {
    readonly name: string
    readonly node: DagNode
    readonly criteria: readonly string[]
  },
  paths: DefinitionPaths,
): void {
  const { name, node, criteria } = input
  if (name.includes('..') || name.endsWith('.lock'))
    throw new DefinitionError(
      'schema',
      `nodes/${name}`,
      'Node IDs must be valid Git ref components',
    )
  if (node.kind === 'command') parse(text, node.argv[0], `nodes/${name}/argv/0`)
  uniqueChecks(node.verify, `nodes/${name}/verify`)
  for (const path of node.write) writePath(path, paths)
  for (const path of node.outputs) outputPath(path)
  for (const path of node.references) literalPath(path, 'references')
  validateContextIndex(node)
  for (const criterion of node.satisfies)
    if (!criteria.includes(criterion))
      throw new DefinitionError(
        'unknown-criterion',
        `nodes/${name}/satisfies`,
        criterion,
      )
  if (
    node.satisfies.length > 0 &&
    node.outputs.length === 0 &&
    node.verify.length === 0
  )
    throw new DefinitionError(
      'unproven-claim',
      `nodes/${name}`,
      'Each claim needs declared checks or named outputs',
    )
}
function validateContextIndex(node: DagNode): void {
  for (const name of node.requiredContext ?? [])
    if (!Object.hasOwn(node.contextIndex ?? {}, name))
      throw new DefinitionError(
        'context-reference',
        `requiredContext/${name}`,
        `Missing frozen context lookup: ${name}`,
      )
  for (const [name, document] of Object.entries(node.contextIndex ?? {})) {
    if (isAbsolute(document.path)) continue
    literalPath(document.path, `contextIndex/${name}/path`)
    if (!node.references.includes(document.path))
      throw new DefinitionError(
        'context-reference',
        `contextIndex/${name}`,
        `Frozen context ${name} must name a declared reference: ${document.path}`,
      )
  }
}
export function parseDag(
  source: string,
  paths: DefinitionPaths,
): DagDefinition {
  const value = yaml(source)
  if (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'plan'
  )
    throw new DefinitionError(
      'unsupported-plan',
      'kind',
      'Use parsePlan to resolve composed kind: plan definitions; parseDag accepts standalone DAGs',
    )
  const authored = parse(dagSchema, value)
  const { verify = [], limits = {} } = authored
  const { concurrency = 1, nodeRetries = 2, repairCycles = 3 } = limits
  const nodes: Record<string, DagNode> = {}
  const criteria = Object.keys(authored.criteria)
  if (criteria.length === 0 || Object.keys(authored.nodes).length === 0)
    throw new DefinitionError(
      'empty-graph',
      'criteria',
      'Declare criteria and delivering nodes',
    )
  for (const criterion of criteria) identifier(criterion, 'criteria')
  uniqueChecks(verify, 'verify')
  for (const [name, node] of Object.entries(authored.nodes)) {
    identifier(name, 'nodes')
    const {
      needs = [],
      references = [],
      write = [],
      satisfies = [],
      outputs = [],
      verify = [],
    } = node
    const resolved = {
      ...node,
      needs,
      references,
      write,
      satisfies,
      outputs,
      verify,
    }
    validateNode({ name, node: resolved, criteria }, paths)
    nodes[name] = resolved
  }
  validateGraph(nodes)
  validateCoverage(
    criteria,
    Object.values(nodes).map((node) => node.satisfies),
  )
  const integrates = Object.values(nodes).some((node) => node.write.length)
  if (integrates && !authored.integration)
    throw new DefinitionError(
      'integration-profile',
      'integration',
      'Any project write requires an integration profile',
    )
  return {
    ...authored,
    nodes,
    limits: { concurrency, nodeRetries, repairCycles },
    verify,
    stages: [
      ...(integrates ? ['integration' as const] : []),
      'checks',
      'review',
    ],
  }
}
export async function validateReferences(
  node: DagNode,
  projectRoot: string,
): Promise<void> {
  await resolveContextIndex(node, projectRoot)
}
export async function resolveContextIndex(
  node: DagNode,
  projectRoot: string,
): Promise<
  Readonly<
    Record<
      string,
      {
        readonly path: string
        readonly sha256: string
        readonly sections: readonly string[]
      }
    >
  >
> {
  validateContextIndex(node)
  const documents = Object.entries(node.contextIndex ?? {})
  const indexed = new Set(documents.map(([, document]) => document.path))
  for (const path of node.references)
    if (!indexed.has(path)) await readBoundary(resolve(projectRoot, path))
  const index: Record<
    string,
    { path: string; sha256: string; sections: readonly string[] }
  > = Object.create(null)
  for (const [name, document] of documents) {
    const absolute = resolve(projectRoot, document.path)
    const bytes = await readFile(absolute).catch((error: unknown) => {
      throw new DefinitionError(
        'context-reference',
        `contextIndex/${name}`,
        `Required frozen context ${name} is unavailable: ${absolute}`,
        { cause: error instanceof Error ? error : new Error(String(error)) },
      )
    })
    if (createHash('sha256').update(bytes).digest('hex') !== document.sha256)
      throw new DefinitionError(
        'context-reference',
        `contextIndex/${name}/sha256`,
        `Frozen context ${name} changed: ${absolute}`,
      )
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    for (const section of document.sections)
      if (
        !content
          .split(/\r?\n/)
          .some((line) => /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1] === section)
      )
        throw new DefinitionError(
          'context-reference',
          `contextIndex/${name}/sections`,
          `Frozen context ${name} is missing section "${section}": ${document.path}`,
        )
    index[name] = {
      path: realpathSync(resolve(projectRoot, document.path)),
      sha256: document.sha256,
      sections: document.sections,
    }
  }
  return index
}
export async function readBoundary(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new DefinitionError(
      'resource',
      path,
      'Required readable file is unavailable',
      { cause: error instanceof Error ? error : new Error(String(error)) },
    )
  }
}
async function snapshotSkills(
  names: readonly string[],
  resources: ReturnType<ResourceLoader['getSkills']>,
): Promise<SkillSnapshot[]> {
  const skills: SkillSnapshot[] = []
  for (const skillName of names) {
    const matches = resources.skills.filter((skill) => skill.name === skillName)
    const skill = matches[0]
    if (
      matches.length !== 1 ||
      !skill ||
      resources.diagnostics.some(
        (item) =>
          item.collision?.resourceType === 'skill' &&
          item.collision.name === skillName,
      )
    )
      throw new DefinitionError(
        'required-skill',
        'skills',
        `Required skill missing or ambiguous: ${skillName}`,
      )
    skills.push({
      name: skill.name,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      content: await readBoundary(skill.filePath),
    })
  }
  return skills
}
export type ReadinessOptions = {
  readonly profiles: Profiles
  readonly modelRuntime: ModelRuntime
  readonly resources: ResourceLoader
}
export async function profileResolver(options: ReadinessOptions) {
  const available = await options.modelRuntime
    .getAvailable()
    .catch((error: unknown) => {
      throw new DefinitionError(
        'model-runtime',
        'profiles',
        'Cannot inspect authenticated model availability',
        { cause: error instanceof Error ? error : new Error(String(error)) },
      )
    })
  function profile(name: string | undefined): Profile {
    const selected =
      name !== undefined && Object.hasOwn(options.profiles, name)
        ? options.profiles[name]
        : undefined
    if (!selected)
      throw new DefinitionError(
        'missing-profile',
        'profile',
        `Configure profile ${name ?? '(missing)'}`,
      )
    const { provider, modelId, model } = resolveProfileModel(
      selected.model,
      options.modelRuntime,
    )
    if (
      !model ||
      !available.some(
        (value) => value.provider === provider && value.id === modelId,
      )
    )
      throw new DefinitionError(
        'unavailable-model',
        `profiles/${name}/model`,
        `Exact authenticated model unavailable: ${selected.model}`,
      )
    return { ...selected }
  }
  return profile
}
export async function resolveAssignments(
  dag: DagDefinition,
  options: ReadinessOptions,
): Promise<AssignmentSnapshots> {
  const used: Record<string, Profile> = {}
  const select = await profileResolver(options)
  function profile(name: string | undefined): Profile {
    const result = select(name)
    used[String(name)] = result
    return result
  }
  const review = profile(dag.review.profile)
  if (review.size !== 'large')
    throw new DefinitionError(
      'small-review',
      'review/profile',
      'Independent review requires a large profile',
    )
  const integration = dag.integration
    ? profile(dag.integration.profile)
    : undefined
  const resources = options.resources.getSkills()
  const instructions = options.resources
    .getAgentsFiles()
    .agentsFiles.map((file) => ({ ...file }))
  const nodes: Record<string, EffectiveAssignment> = {}
  for (const [name, node] of Object.entries(dag.nodes)) {
    const skills: SkillSnapshot[] = []
    let selectedProfile: Profile | undefined
    switch (node.kind) {
      case 'agent':
        selectedProfile = profile(node.profile ?? dag.defaults?.profile)
        skills.push(
          ...(await snapshotSkills(
            node.skills ?? dag.defaults?.skills ?? [],
            resources,
          )),
        )
        break
      case 'command':
        break
      default:
        node satisfies never
    }
    nodes[name] = {
      id: name,
      node: structuredClone(node),
      goal: dag.goal,
      criteria: { ...dag.criteria },
      context: dag.context ?? '',
      profile: selectedProfile,
      skills,
      instructions: structuredClone(instructions),
    }
  }
  return { nodes, integration, review, profiles: used }
}
