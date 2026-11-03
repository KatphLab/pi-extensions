import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type CompactOptions,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionRunner,
  type SessionBeforeCompactEvent,
  type SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { createExtensionHarness } from '../../test-utils/extension-harness.js'
import { getArchive } from './archive.js'
import snapcompactExtension from './index.js'
import { type RenderFrame, renderFrame } from './render.js'

let directory: string
let runner: ExtensionRunner
let session: SessionManager
let model: ExtensionContext['model']
let visionModel: NonNullable<ExtensionContext['model']>
let render: RenderFrame
let usage: ReturnType<ExtensionContext['getContextUsage']>
let idle: boolean
const compact = mock<(options?: CompactOptions) => void>()
const notify = mock()

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-snapcompact-'))
  const harness = await createExtensionHarness(directory, [
    (pi) => snapcompactExtension(pi, (text, shape) => render(text, shape)),
  ])
  runner = harness.runner
  session = harness.session
  const found = harness.registry
    .getAll()
    .find((candidate) => candidate.input.includes('image'))
  if (!found)
    throw new Error('Expected an image-capable model in Pi’s bundled catalog')
  visionModel = { ...found, id: 'claude-test', contextWindow: 200_000 }
  runner.bindCore(harness.runtime, {
    getModel: () => model,
    getScopedModels: () => [],
    isIdle: () => idle,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => usage,
    compact,
    getSystemPrompt: () => '',
  })
})

beforeEach(() => {
  session.resetLeaf()
  model = visionModel
  render = renderFrame
  compact.mock.calls.at(-1)?.[0]?.onComplete?.({
    summary: '',
    firstKeptEntryId: '',
    tokensBefore: 0,
  })
  compact.mockClear()
  usage = undefined
  idle = true
  notify.mockClear()
  runner.setUIContext({ ...runner.getUIContext(), notify }, 'tui')
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

function eventForBranch(): SessionBeforeCompactEvent {
  const branchEntries = session.getBranch()
  const kept = branchEntries.findLast((entry) => entry.type === 'message')
  if (!kept) throw new Error('Expected compactable history')
  const previous = branchEntries.findLast(
    (entry) => entry.type === 'compaction',
  )
  return {
    type: 'session_before_compact',
    preparation: {
      firstKeptEntryId: kept.id,
      messagesToSummarize: session
        .buildSessionContext()
        .messages.slice(0, -1)
        .filter((message) => message.role !== 'compactionSummary'),
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100_000,
      ...(previous ? { previousSummary: previous.summary } : {}),
      fileOps: {
        read: new Set(['read.ts']),
        edited: new Set(['edit.ts']),
        written: new Set(),
      },
      settings: {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 1000,
      },
    },
    branchEntries,
    signal: new AbortController().signal,
    reason: 'manual',
    willRetry: false,
  }
}

function seed(history = 'history '): string {
  const root = session.appendMessage({
    role: 'user',
    content: `ORIGINAL TASK ${history.repeat(20_000)}`,
    timestamp: 1,
  })
  session.appendMessage({
    role: 'user',
    content: `RECENT ${'new '.repeat(1500)}`,
    timestamp: 2,
  })
  return root
}

async function compactBranch() {
  const result = await runner.emit(eventForBranch())
  if (!result?.compaction) throw new Error('Expected bitmap compaction')
  const compaction = result.compaction
  session.appendCompaction(
    compaction.summary,
    compaction.firstKeptEntryId,
    compaction.tokensBefore,
    JSON.parse(JSON.stringify(compaction.details)),
    true,
  )
  return compaction
}

it('loads snapcompact as the package’s only extension through Pi’s manifest discovery', async () => {
  const root = resolve(import.meta.dir, '../../..')
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [root],
  })
  await loader.reload()
  const loaded = loader.getExtensions()
  expect(loaded.errors).toEqual([])
  expect(loaded.extensions.map((extension) => extension.path)).toEqual([
    join(root, 'src/extensions/snapcompact/index.ts'),
  ])
  expect(
    loaded.extensions.flatMap((extension) => [...extension.commands.keys()]),
  ).toEqual([])
})

it('round-trips Unicode history through real PNG archives and follows the active branch', async () => {
  const root = seed('history مرحبا ✅ 🚀 你好 ')
  const result = await compactBranch()
  const archive = getArchive(result.details)
  expect(archive?.frames.length).toBeGreaterThan(0)
  expect(archive?.source).toContain('\\u{645}\\u{631}\\u{62d}\\u{628}\\u{627}')
  expect(archive?.source).toContain('\\u{2705} \\u{1f680} 你好')
  expect(archive?.source).not.toContain('مرحبا')
  const messages = session.buildSessionContext().messages
  const projected = await runner.emitContext(messages)
  const archived = projected.find((message) => message.role === 'custom')
  expect(archived?.role).toBe('custom')
  if (archived?.role !== 'custom' || typeof archived.content === 'string')
    throw new Error('Missing archive')
  expect(archived.content.some((block) => block.type === 'image')).toBe(true)
  expect(messages.some((message) => message.role === 'compactionSummary')).toBe(
    true,
  )
  expect(await runner.emitContext(projected)).toEqual(projected)

  model = { ...visionModel, input: ['text'] }
  const textOnly = await runner.emitContext(messages)
  expect(JSON.stringify(textOnly)).toContain('ORIGINAL TASK')
  expect(JSON.stringify(textOnly)).not.toContain('image/png')

  session.branch(root)
  const branchMessages = session.buildSessionContext().messages
  expect(await runner.emitContext(branchMessages)).toEqual(branchMessages)
})

it('cancels for text-only models but uses Snapcompact even with summary instructions', async () => {
  seed()
  await compactBranch()
  session.appendMessage({
    role: 'user',
    content: 'new turn '.repeat(2000),
    timestamp: 3,
  })
  model = { ...visionModel, input: ['text'] }
  const textEvent = eventForBranch()
  textEvent.preparation.fileOps.read.clear()
  textEvent.preparation.fileOps.edited.clear()
  expect(await runner.emit(textEvent)).toEqual({ cancel: true })
  expect([...textEvent.preparation.fileOps.read]).toEqual([])
  expect([...textEvent.preparation.fileOps.edited]).toEqual([])
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining('image-capable model'),
    'error',
  )

  model = visionModel
  const instructed = {
    ...eventForBranch(),
    customInstructions: 'Focus on decisions',
  }
  const result = await runner.emit(instructed)
  expect(getArchive(result?.compaction?.details)?.source).toContain(
    'ORIGINAL TASK',
  )
})

it.each([new Error('Bundled font unavailable'), 'non-Error failure'])(
  'cancels without summarization when rendering fails: %s',
  async (failure) => {
    seed()
    await compactBranch()
    session.appendMessage({
      role: 'user',
      content: 'more '.repeat(20_000),
      timestamp: 3,
    })
    render = () => Promise.reject(failure)
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const event = eventForBranch()
      expect(await runner.emit(event)).toEqual({ cancel: true })
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining('Compaction cancelled'),
        'error',
      )
      expect(log.mock.calls[0]?.[1]).toBeInstanceOf(Error)
    } finally {
      log.mockRestore()
    }
  },
)

it('cancels without falling back, including an abort during rendering', async () => {
  seed()
  const aborted = eventForBranch()
  aborted.signal = AbortSignal.abort()
  expect(await runner.emit(aborted)).toEqual({ cancel: true })
  const controller = new AbortController()
  render = () => {
    controller.abort()
    return Promise.reject(new Error('Aborted'))
  }
  expect(
    await runner.emit({ ...eventForBranch(), signal: controller.signal }),
  ).toEqual({ cancel: true })
  expect(notify).not.toHaveBeenCalled()
})

it('does not require a model or UI to load and preserves unrelated summaries', async () => {
  seed()
  model = undefined
  runner.setUIContext(undefined, 'print')
  expect(await runner.emit(eventForBranch())).toEqual({ cancel: true })
  const messages: Parameters<ExtensionRunner['emitContext']>[0] = [
    {
      role: 'compactionSummary',
      summary: 'other extension',
      tokensBefore: 1,
      timestamp: 1,
    },
  ]
  expect(await runner.emitContext(messages)).toEqual(messages)
})

it('compacts at 70% only when safely settled and prevents overlapping requests', async () => {
  const settle = () => runner.emit({ type: 'agent_settled', aborted: false })
  await settle()
  usage = { tokens: null, contextWindow: 200_000, percent: null }
  await settle()
  usage = { tokens: 139_999, contextWindow: 200_000, percent: 69.9995 }
  await settle()
  expect(compact).not.toHaveBeenCalled()

  usage = { tokens: 140_000, contextWindow: 200_000, percent: 70 }
  idle = false
  await runner.emitBoundary(
    {
      type: 'turn_end',
      turnIndex: 0,
      message: { role: 'user', content: 'turn', timestamp: 1 },
      messageEntryId: 'message',
      toolResults: [],
      toolResultEntryIds: [],
      outcome: 'completed',
    },
    () => ({
      contextEntries: [],
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue: false,
    }),
  )
  await runner.emit({ type: 'agent_end', messages: [] })
  expect(compact).not.toHaveBeenCalled()
  await runner.emit({ type: 'agent_settled', aborted: false })
  expect(compact).not.toHaveBeenCalled()
  idle = true
  await runner.emit({ type: 'agent_settled', aborted: true })
  expect(compact).not.toHaveBeenCalled()
  await settle()
  await settle()
  expect(compact).toHaveBeenCalledTimes(1)
  compact.mock.calls.at(-1)?.[0]?.onComplete?.({
    summary: '',
    firstKeptEntryId: '',
    tokensBefore: 140_000,
  })
  usage = { tokens: 150_000, contextWindow: 200_000, percent: 75 }
  await settle()
  expect(compact).toHaveBeenCalledTimes(2)

  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const options = compact.mock.calls.at(-1)?.[0]
    options?.onError?.(new Error('sensitive provider diagnostic'))
    expect(notify).toHaveBeenCalledWith(
      expect.not.stringContaining('sensitive'),
      'error',
    )
    runner.setUIContext(undefined, 'json')
    options?.onError?.(new Error('failed'))
    expect(notify).toHaveBeenCalledTimes(1)
    await settle()
    expect(compact).toHaveBeenCalledTimes(3)
  } finally {
    log.mockRestore()
  }
})
