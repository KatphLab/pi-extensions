import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createExtensionHarness } from '../../test-utils/extension-harness.js'
import codeReviewDagExtension from './index.js'

let directory: string
let harness: Awaited<ReturnType<typeof createExtensionHarness>>
let messages: Parameters<ExtensionAPI['sendUserMessage']>[]

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-code-review-dag-'))
  harness = await createExtensionHarness(directory, [codeReviewDagExtension])
  messages = []
  harness.runtime.sendUserMessage = (...args) => {
    messages.push(args)
  }
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function invoke(args: string) {
  const command = harness.runner.getCommand('code-review-dag')
  if (!command) throw new Error('Missing /code-review-dag command')
  await command.handler(args, harness.runner.createCommandContext())
}

it('uses the default review scope when the command receives only whitespace', async () => {
  await invoke('   ')
  expect(messages).toHaveLength(1)
  const prompt = messages[0]?.[0]
  expect(prompt).toEndWith(
    '## Requested scope or requirement\n\nReview first-party source and tests in the current checkout.',
  )
  expect(messages[0]?.[1]).toEqual({ deliverAs: 'followUp' })
})

it('passes custom scope verbatim through the follow-up channel without requiring or replacing editor text', async () => {
  const scope =
    'Changes since main in src/dag; requirement: preserve retries.\nDAG name: retry-review'
  let editor = 'Unfinished user draft'
  harness.runner.setUIContext(
    {
      ...harness.runner.getUIContext(),
      getEditorText: () => editor,
      setEditorText: (text) => {
        editor = text
      },
    },
    'tui',
  )
  await invoke(`  ${scope}  `)
  expect(editor).toBe('Unfinished user draft')

  for (const mode of ['print', 'json', 'rpc'] as const) {
    harness.runner.setUIContext(undefined, mode)
    await invoke(scope)
  }
  expect(messages).toHaveLength(4)
  for (const [content, options] of messages) {
    expect(content).toEndWith(`## Requested scope or requirement\n\n${scope}`)
    expect(options).toEqual({ deliverAs: 'followUp' })
  }
})
