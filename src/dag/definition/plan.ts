import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import { executableNodes } from '@dag/policy.js'
import { arr, obj, oneOf, opt, type Static } from '@earendil-works/pi-schema'
import {
  existingAncestor,
  parseDag,
  profileResolver,
  type ReadinessOptions,
  readBoundary,
  resolveAssignments,
} from './definition.js'
import {
  type Amendment,
  type AssignmentSnapshots,
  type AuthoredDocument,
  type DagDefinition,
  DefinitionError,
  type DefinitionPaths,
  identifier,
  nestedDagSchema,
  type PlanAssignments,
  type PlanDefinition,
  type PlanReviewReceipt,
  type PlanRevision,
  parse,
  parsePlanReviewReceipt,
  parseProfiles,
  planSchema,
  text,
  uniqueChecks,
  validateCoverage,
  validateGraph,
  yaml,
} from './schema.js'

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
type AuthoredPlan = Static<typeof planSchema>
function validatePlanMap(authored: AuthoredPlan): void {
  const criteria = Object.keys(authored.criteria)
  if (criteria.length === 0 || Object.keys(authored.dags).length === 0)
    throw new DefinitionError(
      'empty-graph',
      'dags',
      'Declare criteria and delivering DAGs',
    )
  for (const criterion of criteria) identifier(criterion, 'criteria')
  uniqueChecks(authored.verify ?? [], 'verify')
  const entries: Record<string, { readonly needs: readonly string[] }> = {}
  for (const [name, entry] of Object.entries(authored.dags)) {
    identifier(name, 'dags')
    entries[name] = { needs: entry.needs ?? [] }
    for (const criterion of entry.satisfies ?? [])
      if (!criteria.includes(criterion))
        throw new DefinitionError(
          'unknown-criterion',
          `dags/${name}/satisfies`,
          criterion,
        )
  }
  validateGraph(entries)
  validateCoverage(
    criteria,
    Object.values(authored.dags).map((entry) => entry.satisfies ?? []),
  )
}
async function planDocuments(
  authored: AuthoredPlan,
  paths: DefinitionPaths,
  source: string,
) {
  const path = existingAncestor(
    resolve(paths.projectRoot, paths.definitionPath),
  )
  const profilesPath = existingAncestor(
    resolve(paths.projectRoot, paths.profilesPath),
  )
  const documents: Record<string, AuthoredDocument> = {}
  documents[path] = { path, content: source, sha256: sha256(source) }
  const profiles = await readBoundary(profilesPath)
  documents[profilesPath] = {
    path: profilesPath,
    content: profiles,
    sha256: sha256(profiles),
  }
  const files: Record<string, string> = {}
  for (const [name, entry] of Object.entries(authored.dags)) {
    if ('file' in entry) {
      if (isAbsolute(entry.file))
        throw new DefinitionError(
          'path',
          `dags/${name}/file`,
          'Use a file relative to the parent plan',
        )
      const file = existingAncestor(resolve(dirname(path), entry.file))
      files[name] = file
      const content = await readBoundary(file)
      documents[file] = { path: file, content, sha256: sha256(content) }
    }
  }
  return { path, profilesPath, documents, files }
}
function inheritDag(
  local: Static<typeof nestedDagSchema>,
  authored: AuthoredPlan,
  limits: DagDefinition['limits'],
) {
  const context = [authored.context, local.context]
    .filter((value) => value !== undefined)
    .join('\n\n')
  return {
    ...local,
    ...(context ? { context } : {}),
    defaults: { ...authored.defaults, ...local.defaults },
    limits: {
      ...limits,
      ...local.limits,
      concurrency: Math.min(
        limits.concurrency,
        local.limits?.concurrency ?? limits.concurrency,
      ),
    },
    integration: local.integration ?? authored.integration,
    review: local.review ?? authored.review,
  }
}
/** Structural resolution only. No sessions, worktrees or execution admission. */
export async function parsePlan(
  source: string,
  paths: DefinitionPaths,
): Promise<PlanDefinition> {
  const authored = parse(planSchema, yaml(source))
  validatePlanMap(authored)
  const { path, profilesPath, documents, files } = await planDocuments(
    authored,
    paths,
    source,
  )
  const limits = {
    concurrency: 1,
    nodeRetries: 2,
    repairCycles: 3,
    ...authored.limits,
  }
  const dags: Record<string, PlanDefinition['dags'][string]> = {}
  for (const [name, entry] of Object.entries(authored.dags)) {
    const common = {
      needs: entry.needs ?? [],
      satisfies: entry.satisfies ?? [],
    }
    if ('deferred' in entry) {
      dags[name] = { ...common, kind: 'deferred', deferred: entry.deferred }
      continue
    }
    const file = files[name]
    const document = file === undefined ? undefined : documents[file]
    if (!file || !document)
      throw new DefinitionError(
        'resource',
        `dags/${name}/file`,
        'Missing DAG source',
      )
    const local = parse(nestedDagSchema, yaml(document.content))
    const effective = inheritDag(local, authored, limits)
    const definition = parseDag(JSON.stringify(effective), {
      ...paths,
      definitionPath: file,
      authoredPaths: Object.keys(documents),
    })
    dags[name] = { ...common, kind: 'file', file, definition }
  }
  return freeze({
    ...authored,
    dags,
    limits,
    verify: authored.verify ?? [],
    stages: ['checks', 'review'],
    path,
    projectRoot: realpathSync(paths.projectRoot),
    profilesPath,
    documents,
  })
}
/** Resolve the same SDK profiles, selected resources and instructions as standalone DAGs. */
export async function resolvePlanAssignments(
  plan: PlanDefinition,
  options: Omit<ReadinessOptions, 'profiles'>,
): Promise<PlanAssignments> {
  const profiles = parseProfiles(
    plan.documents[plan.profilesPath]?.content ?? '',
  )
  const readiness = { ...options, profiles }
  const select = await profileResolver(readiness)
  const review = select(plan.review.profile)
  if (review.size !== 'large')
    throw new DefinitionError(
      'small-review',
      'review/profile',
      'Overall review requires a large profile',
    )
  if (plan.integration) select(plan.integration.profile)
  if (plan.defaults?.profile) select(plan.defaults.profile)
  const dags: Record<string, AssignmentSnapshots> = {}
  for (const [name, entry] of Object.entries(plan.dags)) {
    switch (entry.kind) {
      case 'file':
        dags[name] = await resolveAssignments(entry.definition, readiness)
        break
      case 'deferred':
        break
      default:
        entry satisfies never
    }
  }
  return freeze({ dags, review, profiles })
}
const amendmentSchema = obj({
  classification: oneOf(['minor', 'material']),
  reason: text,
  changes: opt(
    arr(
      oneOf([
        'wording',
        'references',
        'context',
        'deliverables',
        'dependencies',
        'interfaces',
        'write-scope',
        'acceptance',
      ]),
      { minItems: 1, uniqueItems: true },
    ),
  ),
})
/** Compare executable policy, not document hashes. Text meaning is declared by the author. */
function materialPolicy(
  plan: PlanDefinition,
  assignments: PlanAssignments,
): string {
  return JSON.stringify(
    {
      name: plan.name,
      criteria: Object.keys(plan.criteria).sort((a, b) => a.localeCompare(b)),
      limits: plan.limits,
      defaults: plan.defaults,
      integration: plan.integration,
      review: plan.review,
      verify: plan.verify,
      profiles: Object.fromEntries(
        Object.entries(assignments.profiles).map(([name, profile]) => [
          name,
          { model: profile.model, size: profile.size },
        ]),
      ),
      dags: Object.fromEntries(
        Object.entries(plan.dags).map(([name, entry]) => [
          name,
          entry.kind === 'deferred'
            ? {
                kind: entry.kind,
                needs: entry.needs,
                satisfies: entry.satisfies,
              }
            : {
                kind: entry.kind,
                needs: entry.needs,
                satisfies: entry.satisfies,
                definition: {
                  ...entry.definition,
                  criteria: Object.keys(entry.definition.criteria).sort(
                    (a, b) => a.localeCompare(b),
                  ),
                  context: undefined,
                  goal: undefined,
                  nodes: executableNodes(entry.definition.nodes),
                },
              },
        ]),
      ),
    },
    (_, value: unknown) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
          )
        : value,
  )
}
type RevisionOptions = Omit<ReadinessOptions, 'profiles'> & {
  readonly reviewSource?: string
  readonly previous?: PlanRevision
  readonly amendment?: Amendment
}
function reviewCoverage(
  plan: PlanDefinition,
  receipt: PlanReviewReceipt,
  previous: PlanRevision | undefined,
): void {
  const covered = new Set<string>()
  for (const document of receipt.documents) {
    const path = existingAncestor(resolve(plan.projectRoot, document.path))
    if (covered.has(path) || plan.documents[path]?.sha256 !== document.sha256)
      throw new DefinitionError(
        'review-identity',
        'review/documents',
        'Stale, unknown or duplicate reviewed document',
      )
    covered.add(path)
  }
  const required = Object.values(plan.documents).filter(
    (document) =>
      !previous ||
      previous.plan.documents[document.path]?.sha256 !== document.sha256,
  )
  if (required.some((document) => !covered.has(document.path)))
    throw new DefinitionError(
      'review-coverage',
      'review/documents',
      'Review must cover every affected authored document, including deferred descriptions',
    )
}
async function readPlanReview(
  plan: PlanDefinition,
  assignments: PlanAssignments,
  options: RevisionOptions,
): Promise<PlanRevision['review']> {
  const reviewPath = resolve(
    dirname(plan.path),
    `${basename(plan.path, extname(plan.path))}.review.json`,
  )
  const source = options.reviewSource ?? (await readBoundary(reviewPath))
  const receipt = parsePlanReviewReceipt(source)
  const profile = (
    await profileResolver({ ...options, profiles: assignments.profiles })
  )(receipt.reviewerProfile)
  if (receipt.verdict !== 'approved' || profile.size !== 'large')
    throw new DefinitionError(
      'plan-review',
      'review',
      'Independent approved large-profile plan review required',
    )
  reviewCoverage(plan, receipt, options.previous)
  const evidencePath = existingAncestor(
    resolve(plan.projectRoot, receipt.evidencePath),
  )
  const content = await readBoundary(evidencePath)
  if (!content.trim())
    throw new DefinitionError(
      'review-evidence',
      'review/evidencePath',
      'Review evidence must be nonempty',
    )
  return { receipt, source, evidence: { path: evidencePath, content } }
}
/** Admission contract for task 13/14: readiness alone is never approval.
 * Initial receipts cover all authored DAGs, the parent (including deferred descriptions), and profiles.
 * Material amendments cover changed documents; a minor amendment retains prior review with a reason.
 */
export async function freezePlanRevision(
  plan: PlanDefinition,
  options: RevisionOptions,
): Promise<PlanRevision> {
  const assignments = await resolvePlanAssignments(plan, options)
  const amendment =
    options.amendment === undefined
      ? undefined
      : parse(amendmentSchema, options.amendment)
  if (Boolean(options.previous) !== Boolean(amendment))
    throw new DefinitionError(
      'amendment',
      'amendment',
      'Supply both previous revision and amendment classification/reason',
    )
  const previous = options.previous
  const material =
    amendment?.changes?.some(
      (change) => !['wording', 'references', 'context'].includes(change),
    ) ?? false
  if (
    previous &&
    amendment?.classification === 'minor' &&
    (material ||
      materialPolicy(previous.plan, previous.assignments) !==
        materialPolicy(plan, assignments))
  )
    throw new DefinitionError(
      'material-amendment',
      'amendment/classification',
      'Changed contracts require material review',
    )
  const review =
    previous && amendment?.classification === 'minor'
      ? previous.review
      : await readPlanReview(plan, assignments, options)
  const revision = {
    plan,
    assignments,
    review,
    ...(previous ? { previous: previous.id } : {}),
    ...(amendment ? { amendment } : {}),
  }
  return freeze({ id: sha256(JSON.stringify(revision)), ...revision })
}
