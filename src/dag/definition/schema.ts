import {
  arr,
  bool,
  compile,
  int,
  lit,
  map,
  obj,
  oneOf,
  opt,
  type Schema,
  type Static,
  str,
  union,
} from '@earendil-works/pi-schema'
import { isAlias, parseDocument, visit } from 'yaml'
export type AuthoredDocument = {
  readonly path: string
  readonly content: string
  readonly sha256: string
}
type SemanticChange =
  | 'wording'
  | 'references'
  | 'context'
  | 'deliverables'
  | 'dependencies'
  | 'interfaces'
  | 'write-scope'
  | 'acceptance'
export type Amendment = {
  readonly classification: 'minor' | 'material'
  readonly reason: string
  readonly changes?: readonly SemanticChange[]
}

export const text = str({ pattern: '\\S' })
const id = str({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' })
const strings = arr(text, { uniqueItems: true })
const argv = arr(str(), { minItems: 1 })
const checkSchema = obj({ id, argv })
const checks = arr(checkSchema)
const role = obj({ profile: id })
const common = {
  needs: opt(arr(id, { uniqueItems: true })),
  references: opt(strings),
  contextIndex: opt(
    map(
      obj({
        path: text,
        sha256: str({ pattern: '^[a-f0-9]{64}$' }),
        sections: strings,
      }),
    ),
  ),
  requiredContext: opt(strings),
  write: opt(strings),
  satisfies: opt(arr(id, { uniqueItems: true })),
  outputs: opt(strings),
  verify: opt(checks),
}
const nodeSchema = union([
  obj({
    ...common,
    kind: lit('agent'),
    task: text,
    profile: opt(id),
    skills: opt(arr(id, { uniqueItems: true })),
  }),
  obj({ ...common, kind: lit('command'), argv }),
])
const defaultsSchema = obj({
  profile: opt(id),
  skills: opt(arr(id, { uniqueItems: true })),
})
const limitsSchema = obj({
  concurrency: opt(int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  nodeRetries: opt(int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  repairCycles: opt(int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
})
const definitionFields = {
  name: id,
  goal: text,
  criteria: map(text),
  context: opt(text),
  defaults: opt(defaultsSchema),
  limits: opt(limitsSchema),
  integration: opt(role),
  review: role,
  verify: opt(checks),
}
const dagFields = {
  schema: lit(1),
  kind: lit('dag'),
  ...definitionFields,
  nodes: map(nodeSchema),
}
export const dagSchema = obj(dagFields)
export const nestedDagSchema = obj({ ...dagFields, review: opt(role) })
const entryFields = {
  needs: opt(arr(id, { uniqueItems: true })),
  satisfies: opt(arr(id, { uniqueItems: true })),
}
export const planSchema = obj({
  schema: lit(1),
  kind: lit('plan'),
  ...definitionFields,
  dags: map(
    union([
      obj({ ...entryFields, file: text }),
      obj({
        ...entryFields,
        deferred: obj({ objective: text, decisionNeeded: text }),
      }),
    ]),
  ),
})
const profileSchema = obj({
  profiles: map(
    obj({
      model: str({ pattern: '^[^/\\s]+/\\S+$' }),
      size: oneOf(['small', 'large']),
      description: opt(text),
    }),
  ),
})
const workerSchema = obj({
  outcome: oneOf(['claimed-complete', 'blocked', 'failed']),
  summary: text,
  deliverables: strings,
  evidence: arr(obj({ criterion: id, paths: strings })),
  findings: arr(obj({ summary: text, evidence: strings, needsAuthor: bool() })),
})
const reviewSchema = obj({
  verdict: oneOf(['approved', 'changes-requested', 'needs-author']),
  summary: text,
  findings: arr(
    obj({
      id,
      severity: oneOf(['blocker', 'note']),
      criterion: id,
      assignment: id,
      evidence: strings,
      requestedChange: text,
    }),
  ),
})
const planReviewSchema = obj({
  verdict: oneOf(['approved', 'changes-requested', 'needs-author']),
  reviewerProfile: id,
  documents: arr(
    obj({ path: text, sha256: str({ pattern: '^[a-f0-9]{64}$' }) }),
    { minItems: 1 },
  ),
  evidencePath: text,
})
type Frozen<T> = T extends readonly (infer E)[]
  ? readonly Frozen<E>[]
  : T extends object
    ? { readonly [K in keyof T]: Frozen<T[K]> }
    : T
export type VerifyCheck = Frozen<Static<typeof checkSchema>>
export type WorkerReport = Frozen<Static<typeof workerSchema>>
export type ReviewReport = Frozen<Static<typeof reviewSchema>>
export type PlanReviewReceipt = Frozen<Static<typeof planReviewSchema>>
export type Profile = Frozen<Static<typeof profileSchema>['profiles'][string]>
export type Profiles = Readonly<Record<string, Profile>>
export type DagNode = Frozen<Static<typeof nodeSchema>> & {
  readonly needs: readonly string[]
  readonly references: readonly string[]
  readonly write: readonly string[]
  readonly satisfies: readonly string[]
  readonly outputs: readonly string[]
  readonly verify: readonly VerifyCheck[]
}
export type DefinitionPaths = {
  readonly projectRoot: string
  readonly definitionPath: string
  readonly profilesPath: string
  readonly authoredPaths?: readonly string[]
}
export type DagDefinition = Omit<
  Frozen<Static<typeof dagSchema>>,
  'nodes' | 'limits' | 'verify'
> & {
  readonly nodes: Readonly<Record<string, DagNode>>
  readonly limits: {
    readonly concurrency: number
    readonly nodeRetries: number
    readonly repairCycles: number
  }
  readonly verify: readonly VerifyCheck[]
  readonly stages: readonly ('integration' | 'checks' | 'review')[]
}
export type SkillSnapshot = {
  readonly name: string
  readonly filePath: string
  readonly baseDir: string
  readonly content: string
}
export type EffectiveAssignment = {
  readonly id: string
  readonly node: DagNode
  readonly goal: string
  readonly criteria: Readonly<Record<string, string>>
  readonly context: string
  readonly profile: Profile | undefined
  readonly skills: readonly SkillSnapshot[]
  readonly instructions: readonly {
    readonly path: string
    readonly content: string
  }[]
}
export type AssignmentSnapshots = {
  readonly nodes: Readonly<Record<string, EffectiveAssignment>>
  readonly integration: Profile | undefined
  readonly review: Profile
  readonly profiles: Profiles
}
type PlanEntry = {
  readonly needs: readonly string[]
  readonly satisfies: readonly string[]
} & (
  | {
      readonly kind: 'file'
      readonly file: string
      readonly definition: DagDefinition
    }
  | {
      readonly kind: 'deferred'
      readonly deferred: {
        readonly objective: string
        readonly decisionNeeded: string
      }
    }
)
export type PlanDefinition = {
  readonly schema: 1
  readonly kind: 'plan'
  readonly name: string
  readonly goal: string
  readonly criteria: Readonly<Record<string, string>>
  readonly context?: string
  readonly defaults?: DagDefinition['defaults']
  readonly limits: DagDefinition['limits']
  readonly integration?: { readonly profile: string }
  readonly review: { readonly profile: string }
  readonly verify: readonly VerifyCheck[]
  readonly dags: Readonly<Record<string, PlanEntry>>
  readonly stages: readonly ['checks', 'review']
  readonly path: string
  readonly projectRoot: string
  readonly profilesPath: string
  readonly documents: Readonly<Record<string, AuthoredDocument>>
}
export type PlanAssignments = {
  readonly dags: Readonly<Record<string, AssignmentSnapshots>>
  readonly review: Profile
  readonly profiles: Profiles
}
export type PlanRevision = {
  readonly id: string
  readonly plan: PlanDefinition
  readonly assignments: PlanAssignments
  readonly review: {
    readonly receipt: PlanReviewReceipt
    readonly source: string
    readonly evidence: { readonly path: string; readonly content: string }
  }
  readonly previous?: string
  readonly amendment?: Amendment
}

export class DefinitionError extends Error {
  constructor(
    readonly code: string,
    readonly field: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DefinitionError'
  }
}
export function parse<T>(schema: Schema<T>, value: unknown, field = ''): T {
  const validator = compile(schema)
  if (validator.check(value)) return value
  const error = validator.errors(value)[0]
  throw new DefinitionError(
    'schema',
    `${field}${error?.path ?? ''}`,
    error?.message ?? 'Invalid definition',
  )
}
export function yaml(source: string): unknown {
  const document = parseDocument(source, { uniqueKeys: true })
  const error = document.errors[0]
  if (error)
    throw new DefinitionError(error.code, '', error.message, { cause: error })
  visit(document, (_, node) => {
    if (isAlias(node))
      throw new DefinitionError(
        'alias',
        '',
        'YAML aliases are not supported; write policy values explicitly',
      )
  })
  const value: unknown = document.toJS({ maxAliasCount: 0 })
  return value
}
export function identifier(value: string, field: string): void {
  parse(id, value, `${field}/${value}`)
}
export function uniqueChecks(
  values: readonly VerifyCheck[],
  field: string,
): void {
  if (new Set(values.map((check) => check.id)).size !== values.length)
    throw new DefinitionError(
      'duplicate-check',
      field,
      'Check IDs must be unique in their scope',
    )
  for (const check of values)
    parse(text, check.argv[0], `${field}/${check.id}/argv/0`)
}
export function parseProfiles(source: string): Profiles {
  const result = parse(profileSchema, yaml(source)).profiles
  for (const name of Object.keys(result)) identifier(name, 'profiles')
  return result
}
export function validateGraph(
  nodes: Readonly<Record<string, { readonly needs: readonly string[] }>>,
): void {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function walk(name: string): void {
    if (visiting.has(name))
      throw new DefinitionError(
        'cycle',
        `nodes/${name}/needs`,
        'Dependency cycle',
      )
    if (visited.has(name)) return
    const node = Object.hasOwn(nodes, name) ? nodes[name] : undefined
    if (!node)
      throw new DefinitionError(
        'unknown-dependency',
        `nodes/${name}`,
        'Unknown prerequisite',
      )
    visiting.add(name)
    for (const prerequisite of node.needs) walk(prerequisite)
    visiting.delete(name)
    visited.add(name)
  }
  for (const name of Object.keys(nodes)) walk(name)
}
export function validateCoverage(
  criteria: readonly string[],
  claims: readonly (readonly string[])[],
): void {
  for (const criterion of criteria)
    if (!claims.some((claim) => claim.includes(criterion)))
      throw new DefinitionError(
        'undelivered-criterion',
        `criteria/${criterion}`,
        'Criterion has no delivering assignment',
      )
}
function report<T>(schema: Schema<T>, source: string): T {
  if (Buffer.byteLength(source, 'utf8') > 32 * 1024)
    throw new DefinitionError(
      'oversize-report',
      '',
      'Reports must fit within 32 KiB',
    )
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new DefinitionError('report-json', '', 'Report must be valid JSON', {
      cause: error instanceof Error ? error : new Error(String(error)),
    })
  }
  return parse(schema, value)
}
export function parseWorkerReport(source: string): WorkerReport {
  return report(workerSchema, source)
}
export function parseReviewReport(source: string): ReviewReport {
  return report(reviewSchema, source)
}
export function parsePlanReviewReceipt(source: string): PlanReviewReceipt {
  return report(planReviewSchema, source)
}
