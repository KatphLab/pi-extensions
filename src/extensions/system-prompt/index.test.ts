import { expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExtensionHarness } from '../../test-utils/extension-harness.js'
import systemPromptExtension from './index.js'

it('adds guidance without replacing existing instructions or duplicating it on later runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-system-prompt-'))
  const prompts: string[] = []
  try {
    const { runner } = await createExtensionHarness(directory, [
      systemPromptExtension,
      (pi) => {
        pi.on('before_agent_start', (event) => {
          prompts.push(event.systemPrompt)
        })
      },
    ])
    const existing = {
      cwd: directory,
      appendSystemPrompt: 'Personal instructions',
      contextFiles: [
        { path: join(directory, 'AGENTS.md'), content: 'Repository rules' },
      ],
      sections: { other_extension: 'Keep this extension context' },
    }
    const first = await runner.emitBeforeAgentStart(
      { messageType: 'user', prompt: 'Review this project' },
      existing,
    )
    expect(first.systemPromptOptions).toMatchObject(existing)
    expect(first.systemPromptOptions.forceSystemPrompt).toBeUndefined()
    const prompt = prompts[0]
    expect(prompt).toContain('Personal instructions')
    expect(prompt).toContain('Repository rules')
    expect(prompt).toContain('Keep this extension context')
    expect(prompt).toContain('requests are read-only')
    expect(prompt).toContain('Verify significant changes')

    await runner.emitBeforeAgentStart(
      {
        messageType: 'custom',
        message: {
          role: 'custom',
          customType: 'continuation',
          content: 'Continue the review',
          display: false,
          timestamp: 1,
        },
      },
      first.systemPromptOptions,
    )
    expect(prompts[1]).toBe(prompt)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
