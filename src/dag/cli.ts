#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { runPlan } from '@dag/composition/composition.js'
import {
  amendPlan,
  restartPlan,
  resumePlan,
} from '@dag/composition/recovery.js'
import {
  parseDag,
  resolveAssignments,
  validateReferences,
} from '@dag/definition/definition.js'
import { resolveProfileModel } from '@dag/definition/model.js'
import {
  freezePlanRevision,
  parsePlan,
  resolvePlanAssignments,
} from '@dag/definition/plan.js'
import {
  type DagDefinition,
  DefinitionError,
  type PlanDefinition,
  type Profiles,
  parsePlanReviewReceipt,
  parseProfiles,
} from '@dag/definition/schema.js'
import { amendDag } from '@dag/run/amendment.js'
import { RunError } from '@dag/run/error.js'
import { restartDag, resumeDag } from '@dag/run/recovery.js'
import { runDag } from '@dag/run/run.js'
import { WorkspaceError } from '@dag/workspace/workspace.js'
import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  readStoredCredential,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import {
  arr,
  bool,
  compile,
  lit,
  map,
  obj,
  oneOf,
  opt,
  type Static,
  str,
  union,
} from '@earendil-works/pi-schema'
import { parseDocument } from 'yaml'
import { targetedReviewSource } from './builtins/review.js'
import { executionExit, runStatus, summarizeRun, watchRun } from './monitor.js'
import { modelReadiness } from './readiness.js'
import { type RunState, readRunState, StateError } from './state.js'

class UsageError extends Error {}
function fingerprint(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}
function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
const operandSchema = str({ minLength: 1 })
const requestContract = union([
  obj({
    command: oneOf(['review', 'review-dag']),
    operand: operandSchema,
    profiles: opt(operandSchema),
  }),
  obj({
    command: lit('validate'),
    operand: operandSchema,
    profiles: operandSchema,
    'probe-models': opt(bool()),
  }),
  obj({ command: lit('run'), operand: operandSchema, profiles: operandSchema }),
  obj({
    command: oneOf(['status', 'resume']),
    operand: operandSchema,
  }),
  obj({ command: lit('watch'), operand: operandSchema, compact: opt(bool()) }),
  obj({
    command: lit('summary'),
    operand: operandSchema,
    'approval-session': opt(arr(operandSchema)),
  }),
  obj({
    command: lit('restart'),
    operand: operandSchema,
    assignment: operandSchema,
    reason: operandSchema,
  }),
  obj({
    command: lit('amend'),
    operand: operandSchema,
    definition: operandSchema,
    classification: oneOf(['minor', 'material']),
    reason: operandSchema,
    review: str(),
  }),
])
const requestSchema = compile(requestContract)
const frozenSource = compile(obj({ source: map(str()) }, { open: true }))
const frozenPlan = compile(
  obj({ plan: obj({ profilesPath: str() }, { open: true }) }, { open: true }),
)
type CliRequest = Static<typeof requestContract>
const operandCounts: Readonly<Record<string, number>> = {
  restart: 3,
  amend: 3,
}
function argumentsFor(argv: readonly string[]) {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: {
      profiles: { type: 'string' },
      'probe-models': { type: 'boolean' },
      compact: { type: 'boolean' },
      'approval-session': { type: 'string', multiple: true },
      reason: { type: 'string' },
      classification: { type: 'string' },
      review: { type: 'string' },
    },
  })
  const [command, operand, assignment] = parsed.positionals
  if (parsed.positionals.length !== (operandCounts[command ?? ''] ?? 2))
    throw new UsageError('Supply exactly the documented operands')
  const options = parsed.tokens
    .filter((token) => token.kind === 'option')
    .map((token) => token.name)
    .filter((name) => name !== 'approval-session')
  if (new Set(options).size !== options.length)
    throw new UsageError('Options may appear only once')
  const value: unknown = {
    command,
    ...(operand === undefined ? {} : { operand }),
    ...parsed.values,
    ...(command === 'restart' ? { assignment } : {}),
    ...(command === 'amend'
      ? { definition: assignment, review: parsed.values.review ?? '' }
      : {}),
  }
  if (!requestSchema.check(value))
    throw new UsageError(
      'Usage: dag-cli review-dag <file> [--profiles <file>] (alias: review <file>); validate <definition-or-plan> --profiles <file> [--probe-models]; run <definition-or-plan> --profiles <file>; status|resume <run-dir>; summary <run-dir> [--approval-session <file>]; watch <run-dir> [--compact]; restart <run-dir> <dag-id/node-id|overall-review> --reason <text>; amend <run-dir> <definition> --classification minor|material --reason <text> [--review <receipt>]',
    )
  return value
}
async function reviewed(options: {
  readonly definition: string
  readonly profilesPath: string
  readonly profiles: Profiles
  readonly source: Readonly<Record<string, string>>
  readonly runtime: ModelRuntime
  readonly reviewPath?: string
  readonly root?: string
}): Promise<Record<string, string>> {
  const path =
    options.reviewPath ??
    join(
      dirname(options.definition),
      `${basename(options.definition, extname(options.definition))}.review.json`,
    )
  const bytes = fs.readFileSync(path, 'utf8')
  const review = parsePlanReviewReceipt(bytes)
  const profile = options.profiles[review.reviewerProfile]
  if (review.verdict !== 'approved' || profile?.size !== 'large')
    throw new UsageError(
      'Initial run requires an approved independent large-profile plan review',
    )
  const { provider, modelId } = resolveProfileModel(
    profile.model,
    options.runtime,
  )
  if (
    !(await options.runtime.getAvailable()).some(
      (model) => model.provider === provider && model.id === modelId,
    )
  )
    throw new UsageError(
      'Plan reviewer exact model is unavailable or unauthenticated',
    )
  reviewDocuments(options, review.documents)
  const evidence = fs.realpathSync(
    resolve(options.root ?? process.cwd(), review.evidencePath),
  )
  if (!fs.lstatSync(evidence).isFile() || fs.statSync(evidence).size === 0)
    throw new UsageError(
      'Plan review evidence must be an existing nonempty file',
    )
  return { [path]: bytes, [evidence]: fs.readFileSync(evidence, 'utf8') }
}
function reviewDocuments(
  options: {
    readonly definition: string
    readonly profilesPath: string
    readonly source: Readonly<Record<string, string>>
    readonly root?: string
  },
  documents: readonly { readonly path: string; readonly sha256: string }[],
): void {
  const identities = new Map<string, string>()
  for (const document of documents) {
    const documentPath = fs.realpathSync(
      resolve(options.root ?? process.cwd(), document.path),
    )
    if (
      identities.has(documentPath) ||
      fingerprint(
        options.source[documentPath] ?? fs.readFileSync(documentPath, 'utf8'),
      ) !== document.sha256
    )
      throw new UsageError(
        'Plan review document identity is stale or duplicated',
      )
    identities.set(documentPath, document.sha256)
  }
  if (
    ![options.definition, options.profilesPath].every((document) =>
      identities.has(document),
    )
  )
    throw new UsageError(
      'Plan review must identify the exact definition and profiles',
    )
}
function configurationRuntime(profiles: Profiles, readOnly: boolean) {
  return ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
    ...(readOnly
      ? {
          credentials: {
            read: (provider: string) =>
              Promise.resolve(readStoredCredential(provider)),
            list: () =>
              Promise.resolve(
                [
                  ...new Set(
                    Object.values(profiles).map(
                      (profile) => profile.model.split('/')[0] ?? '',
                    ),
                  ),
                ].flatMap((providerId) => {
                  const credential = readStoredCredential(providerId)
                  return credential
                    ? [{ providerId, type: credential.type }]
                    : []
                }),
              ),
            modify: () =>
              Promise.reject(
                new UsageError(
                  'Validation cannot refresh credentials; authenticate first',
                ),
              ),
            delete: () =>
              Promise.reject(
                new UsageError('Validation cannot modify credentials'),
              ),
          },
        }
      : {}),
  })
}
async function validateInitialReferences(
  definition: DagDefinition,
  root: string,
): Promise<void> {
  for (const node of Object.values(definition.nodes))
    if (node.needs.length === 0) await validateReferences(node, root)
}

async function authorPlan(options: {
  readonly plan: PlanDefinition
  readonly runtime: ModelRuntime
  readonly resources: DefaultResourceLoader
  readonly command: 'run' | 'validate'
  readonly probeModels: boolean
  readonly signal: AbortSignal
}): Promise<number> {
  const { plan, runtime, resources, command, signal } = options
  await resolvePlanAssignments(plan, { modelRuntime: runtime, resources })
  for (const entry of Object.values(plan.dags)) {
    if (entry.kind !== 'file' || entry.needs.length > 0) continue
    await validateInitialReferences(entry.definition, plan.projectRoot)
  }
  if (command === 'validate') {
    output({
      valid: true,
      name: plan.name,
      dags: Object.keys(plan.dags),
      stages: plan.stages,
      ...(await modelReadiness(
        runtime,
        parseProfiles(plan.documents[plan.profilesPath]?.content ?? ''),
        options.probeModels,
        signal,
      )),
    })
    return 0
  }
  const revision = await freezePlanRevision(plan, {
    modelRuntime: runtime,
    resources,
  })
  const runId = `${plan.name}-${Bun.randomUUIDv7()}`
  const runDirectory = join(plan.projectRoot, '.pi/dags/runs', runId)
  output({ runId, runDirectory, evidence: join(runDirectory, 'evidence') })
  const result = await runPlan({ revision, runId, runtime, signal })
  output({
    runId,
    runDirectory,
    status: result.state.status,
    evidence: join(runDirectory, 'evidence'),
  })
  return signal.aborted ? 130 : executionExit(result.state)
}
type BundledReview = {
  readonly target: string
}
async function authoredInputs(
  args: Extract<CliRequest, { command: 'run' | 'validate' }>,
  bundled?: BundledReview,
) {
  const definitionPath = fs.realpathSync(args.operand)
  const bundledSource = fs.readFileSync(definitionPath, 'utf8')
  const definitionSource = bundled
    ? targetedReviewSource(bundledSource, bundled.target, args.profiles)
    : bundledSource
  const profilesPath = fs.realpathSync(args.profiles)
  const paths = { projectRoot: process.cwd(), definitionPath, profilesPath }
  const plan =
    parseDocument(definitionSource).get('kind') === 'plan'
      ? await parsePlan(definitionSource, paths)
      : undefined
  const source = {
    [definitionPath]: definitionSource,
    [profilesPath]: plan
      ? (plan.documents[plan.profilesPath]?.content ?? '')
      : fs.readFileSync(profilesPath, 'utf8'),
  }
  const profiles = parseProfiles(source[profilesPath] ?? '')
  return { definitionPath, profilesPath, paths, plan, source, profiles }
}
async function authorRun(
  args: Extract<CliRequest, { command: 'run' | 'validate' }>,
  signal: AbortSignal,
  bundled?: BundledReview,
): Promise<number> {
  const { definitionPath, profilesPath, paths, plan, source, profiles } =
    await authoredInputs(args, bundled)
  const probeModels =
    args.command === 'validate' ? Boolean(args['probe-models']) : false
  const runtime = await configurationRuntime(
    profiles,
    args.command === 'validate' && !probeModels,
  )
  const resources = amendmentResources(process.cwd())
  await resources.reload()
  if (plan)
    return authorPlan({
      plan,
      runtime,
      resources,
      command: args.command,
      probeModels,
      signal,
    })
  const definition = parseDag(source[definitionPath] ?? '', paths)
  const assignments = await resolveAssignments(definition, {
    profiles,
    modelRuntime: runtime,
    resources,
  })
  await validateInitialReferences(definition, process.cwd())

  if (args.command === 'validate') {
    output({
      valid: true,
      name: definition.name,
      nodes: Object.keys(definition.nodes),
      stages: definition.stages,
      ...(await modelReadiness(runtime, profiles, probeModels, signal)),
    })
    return 0
  }
  const reviewSource = bundled
    ? {}
    : await reviewed({
        definition: definitionPath,
        profilesPath,
        profiles,
        source,
        runtime,
      })
  const runId = `${definition.name}-${Bun.randomUUIDv7()}`
  const runDirectory = join(
    fs.realpathSync(process.cwd()),
    '.pi/dags/runs',
    runId,
  )
  output({
    runId,
    runDirectory,
    evidence: join(runDirectory, 'evidence'),
  })
  const result = await runDag({
    ownership: bundled ? 'run' : undefined,
    projectRoot: process.cwd(),
    runId,
    definition,
    assignments,
    source: { ...source, ...reviewSource },
    runtime,
    signal,
  })
  output({
    runId,
    runDirectory,
    status: result.state.status,
    evidence: join(runDirectory, 'evidence'),
  })
  return signal.aborted ? 130 : executionExit(result.state)
}
function amendmentResources(root: string): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: root,
    agentDir: getAgentDir(),
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
  })
}
async function amendStandalone(options: {
  readonly args: Extract<CliRequest, { command: 'amend' }>
  readonly state: RunState
  readonly runDirectory: string
  readonly definitionPath: string
}): Promise<RunState> {
  const { args, state, runDirectory, definitionPath } = options
  const effective = state.snapshots['effective']
  if (!effective) throw new UsageError('Missing frozen definition')
  const frozen: unknown = JSON.parse(fs.readFileSync(effective, 'utf8'))
  if (!frozenSource.check(frozen))
    throw new UsageError('Invalid frozen definition')
  const previousSource = frozen.source
  const profilesPath = Object.entries(previousSource).find(([, bytes]) => {
    try {
      parseProfiles(bytes)
      return true
    } catch {
      return false
    }
  })?.[0]
  if (!profilesPath) throw new UsageError('Missing frozen profiles')
  const source = {
    ...previousSource,
    [definitionPath]: fs.readFileSync(definitionPath, 'utf8'),
    [profilesPath]: fs.readFileSync(profilesPath, 'utf8'),
  }
  const profiles = parseProfiles(source[profilesPath] ?? '')
  const definition = parseDag(source[definitionPath] ?? '', {
    projectRoot: state.target.root,
    definitionPath,
    profilesPath,
  })
  const reviewPath = args.review ? fs.realpathSync(args.review) : undefined
  const runtime = await configurationRuntime(profiles, false)
  const resources = amendmentResources(state.target.root)
  await resources.reload()
  const assignments = await resolveAssignments(definition, {
    profiles,
    modelRuntime: runtime,
    resources,
  })
  const reviewedSource = reviewPath
    ? await reviewed({
        definition: definitionPath,
        profilesPath,
        profiles,
        source,
        runtime,
        reviewPath,
        root: state.target.root,
      })
    : {}
  return amendDag({
    runDirectory,
    definition,
    assignments,
    source: { ...source, ...reviewedSource },
    classification: args.classification,
    reason: args.reason,
    ...(reviewPath ? { reviewPath } : {}),
    onPreview: (preview) =>
      output({
        amendment: {
          classification: args.classification,
          reason: args.reason,
          ...preview,
        },
      }),
  })
}
async function amendComposition(options: {
  readonly args: Extract<CliRequest, { command: 'amend' }>
  readonly state: RunState
  readonly runDirectory: string
  readonly definitionPath: string
  readonly reviewSource?: string
}): Promise<RunState> {
  const { args, state, runDirectory, definitionPath, reviewSource } = options
  const snapshot = state.snapshots['plan']
  if (!snapshot) throw new UsageError('Missing frozen plan')
  const previous: unknown = JSON.parse(fs.readFileSync(snapshot, 'utf8'))
  if (!frozenPlan.check(previous)) throw new UsageError('Invalid frozen plan')
  const profilesPath = previous.plan.profilesPath
  const plan = await parsePlan(fs.readFileSync(definitionPath, 'utf8'), {
    projectRoot: state.target.root,
    definitionPath,
    profilesPath,
  })
  const profiles = parseProfiles(
    plan.documents[plan.profilesPath]?.content ?? '',
  )
  const runtime = await configurationRuntime(profiles, false)
  const resources = amendmentResources(state.target.root)
  await resources.reload()
  return amendPlan({
    runDirectory,
    plan,
    amendment: { classification: args.classification, reason: args.reason },
    ...(reviewSource ? { reviewSource } : {}),
    runtime,
    resources,
    onPreview: (preview) =>
      output({
        amendment: {
          classification: args.classification,
          reason: args.reason,
          ...preview,
        },
      }),
  })
}
async function authorAmend(
  args: Extract<CliRequest, { command: 'amend' }>,
): Promise<RunState> {
  const runDirectory = fs.realpathSync(args.operand)
  const state = readRunState(runDirectory)
  const definitionPath = fs.realpathSync(args.definition)
  if (args.classification === 'material' && !args.review)
    throw new UsageError('Material amendment requires --review <receipt>')
  if (args.classification === 'minor' && args.review)
    throw new UsageError(
      'Minor amendment retains the original approval; omit --review',
    )
  if (!args.reason.trim()) throw new UsageError('Amendment reason is required')
  return await (state.children === undefined
    ? amendStandalone({ args, state, runDirectory, definitionPath })
    : amendComposition({
        args,
        state,
        runDirectory,
        definitionPath,
        ...(args.review
          ? {
              reviewSource: fs.readFileSync(
                fs.realpathSync(args.review),
                'utf8',
              ),
            }
          : {}),
      }))
}
async function dispatch(
  args: CliRequest,
  signal: AbortSignal,
): Promise<number> {
  switch (args.command) {
    case 'review':
    case 'review-dag':
      return authorRun(
        {
          command: 'run',
          operand: fileURLToPath(
            new URL('./builtins/review-dag.yaml', import.meta.url),
          ),
          profiles: args.profiles ?? join(getAgentDir(), 'dag-profiles.yaml'),
        },
        signal,
        { target: args.operand },
      )
    case 'status':
      output(runStatus(resolve(args.operand)))
      return 0
    case 'summary':
      output(
        await summarizeRun(resolve(args.operand), args['approval-session']),
      )
      return 0
    case 'watch':
      return watchRun(resolve(args.operand), signal, output, args.compact)
    case 'restart': {
      const runDirectory = fs.realpathSync(args.operand)
      const state = readRunState(runDirectory)
      output(
        await (state.children === undefined ? restartDag : restartPlan)({
          runDirectory,
          assignment: args.assignment,
          reason: args.reason,
        }),
      )
      return 0
    }
    case 'amend':
      output(await authorAmend(args))
      return 0
    case 'resume': {
      const runtime = await ModelRuntime.create({
        allowModelNetwork: false,
        refreshOnCreate: false,
      })
      await runtime.getAvailable()
      const runDirectory = fs.realpathSync(args.operand)
      const state = readRunState(runDirectory)
      const result =
        state.children === undefined
          ? await resumeDag({ runDirectory, runtime, signal })
          : await resumePlan({ runDirectory, runtime, signal })
      output({
        runDirectory: result.runDirectory,
        runId: result.state.runId,
        status: result.state.status,
        evidence: join(result.runDirectory, 'evidence'),
      })
      return signal.aborted ? 130 : executionExit(result.state)
    }
    case 'validate':
    case 'run':
      return authorRun(args, signal)
    default:
      throw new UsageError(args satisfies never)
  }
}
export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(
      'Usage: dag-cli review-dag <file> [--profiles <file>]\n' +
        'Alias: dag-cli review <file> [--profiles <file>]\n' +
        'Review only the supplied DAG YAML and suggest improvements to that file.\n' +
        'Referenced code, repository files and commands are not inspected or executed.\n' +
        'Profiles select the review models, not additional review evidence; default: dag-profiles.yaml in the Pi agent directory.\n' +
        'Bundled workflows skip initial approval; independent result review remains required.\n' +
        'Custom workflows: dag-cli run|validate <definition-or-plan> --profiles <file>\n' +
        'Recovery: dag-cli status|watch|summary|resume <run-dir>\n' +
        'Amend: dag-cli amend <run-dir> <definition> --classification minor|material --reason <text> [--review <receipt>]\n' +
        'Restart: dag-cli restart <run-dir> <assignment> --reason <text>\n',
    )
    return 0
  }
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    return await dispatch(argumentsFor(argv), controller.signal)
  } catch (value) {
    const error = value instanceof Error ? value : new Error(String(value))
    process.stderr.write(`${error.message}\n`)
    if (controller.signal.aborted) return 130
    if (
      [UsageError, DefinitionError, StateError, RunError, WorkspaceError].some(
        (type) => error instanceof type,
      ) ||
      'code' in error
    )
      return 2
    return 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
