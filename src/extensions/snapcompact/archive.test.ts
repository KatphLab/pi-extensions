import { expect, it } from 'bun:test'
import type { SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent'
import { buildArchive, getArchive, historyContent } from './archive.js'
import type { Frame } from './render.js'

function preparation(text: string): SessionBeforeCompactEvent['preparation'] {
  return {
    firstKeptEntryId: 'kept',
    messagesToSummarize: [{ role: 'user', content: text, timestamp: 1 }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 100_000,
    fileOps: {
      read: new Set(['read.ts']),
      written: new Set(),
      edited: new Set(['edit.ts']),
    },
    settings: {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    },
  }
}

const reader = {
  id: 'claude',
  api: 'anthropic-messages',
  contextWindow: 200_000,
}
const frame: Frame = { type: 'image', mimeType: 'image/png', data: 'cG5n' }
const render = () => Promise.resolve(frame)

it('keeps small histories, previous summaries, and split-turn prefixes as text without rendering', async () => {
  const input = preparation('Keep this decision')
  input.previousSummary = 'prior summary'
  input.turnPrefixMessages.push({
    role: 'user',
    content: 'split prefix',
    timestamp: 2,
  })
  const result = await buildArchive(
    input,
    reader,
    undefined,
    () => {
      throw new Error('Not needed')
    },
    new AbortController().signal,
  )
  const archive = getArchive(result.details)
  expect(archive?.source).toContain('Keep this decision')
  expect(archive?.source).toContain('prior summary')
  expect(archive?.source).toContain('split prefix')
  expect(archive?.frames).toEqual([])
  expect(result.firstKeptEntryId).toBe('kept')
  expect(result.summary).toContain('edit.ts')
  expect(historyContent(result.summary, archive, false)).toEqual(
    historyContent(result.summary, archive, true),
  )
})

it('bounds repeated archives, preserves both edges and carries file operations', async () => {
  const first = await buildArchive(
    preparation(`ORIGINAL ${'a'.repeat(300_000)} END`),
    reader,
    undefined,
    render,
    new AbortController().signal,
  )
  const old = getArchive(first.details)
  expect(old?.source).toContain('ORIGINAL')
  expect(old?.source).toContain('END')
  expect(old?.truncatedChars).toBeGreaterThan(0)
  expect(old?.frames.length).toBeLessThanOrEqual(3)
  const next = preparation('NEW DECISION')
  next.fileOps.edited.add('read.ts')
  const second = await buildArchive(
    next,
    reader,
    old,
    render,
    new AbortController().signal,
  )
  const archive = getArchive(second.details)
  expect(archive?.source).toContain('ORIGINAL')
  expect(archive?.source).toContain('NEW DECISION')
  expect(archive?.truncatedChars).toBeGreaterThanOrEqual(
    old?.truncatedChars ?? 0,
  )
  expect(second.summary).toContain('characters omitted')
  expect(second.details?.readFiles).toEqual([])
  expect(second.details?.modifiedFiles).toEqual(['edit.ts', 'read.ts'])
  expect(
    historyContent(second.summary, archive, true).filter(
      (block) => block.type === 'image',
    ),
  ).toHaveLength(archive?.frames.length ?? 0)
  expect(
    historyContent(second.summary, archive, false).some(
      (block) => block.type === 'image',
    ),
  ).toBe(false)
})

it('rejects oversized rendered data and observes cancellation between pages', async () => {
  const input = preparation('x'.repeat(40_000))
  await expect(
    buildArchive(
      input,
      reader,
      undefined,
      () => Promise.resolve({ ...frame, data: 'a'.repeat(3_000_001) }),
      new AbortController().signal,
    ),
  ).rejects.toThrow('byte budget')
  const controller = new AbortController()
  await expect(
    buildArchive(
      input,
      reader,
      undefined,
      () => {
        controller.abort()
        return Promise.resolve(frame)
      },
      controller.signal,
    ),
  ).rejects.toThrow()
})

it('validates persisted archives before reattaching data', async () => {
  const result = await buildArchive(
    preparation('text'),
    reader,
    undefined,
    render,
    new AbortController().signal,
  )
  expect(getArchive(JSON.parse(JSON.stringify(result.details)))).toEqual(
    getArchive(result.details),
  )
  for (const value of [
    null,
    {},
    { snapcompact: { version: 2 } },
    {
      snapcompact: {
        ...getArchive(result.details),
        frames: [{ ...frame, mimeType: 'text/html' }],
      },
    },
    {
      snapcompact: {
        ...getArchive(result.details),
        frames: [
          { ...frame, data: 'a'.repeat(1_600_000) },
          { ...frame, data: 'b'.repeat(1_600_000) },
        ],
      },
    },
  ]) {
    expect(getArchive(value)).toBeUndefined()
  }
})
