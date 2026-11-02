import { expect, it } from 'bun:test'
import type { ContextEvent } from '@earendil-works/pi-coding-agent'
import { serializeConversation } from './serialize.js'

it('keeps speaker and tool semantics while bounding output and omitting private reasoning', () => {
  const messages: ContextEvent['messages'] = [
    { role: 'system', content: 'system checkpoint', timestamp: 1 },
    { role: 'user', content: 'user goal', timestamp: 1 },
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'private reasoning',
          thinkingSignature: 'opaque signature',
        },
        { type: 'text', text: 'visible answer' },
        {
          type: 'toolCall',
          id: 'call',
          name: 'edit',
          arguments: { text: `START${'x'.repeat(5000)}END` },
        },
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'test',
      stopReason: 'toolUse',
      timestamp: 2,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    {
      role: 'toolResult',
      toolCallId: 'call',
      toolName: 'edit',
      isError: true,
      content: [{ type: 'text', text: `HEAD${'y'.repeat(5000)}TAIL` }],
      timestamp: 3,
    },
    {
      role: 'custom',
      customType: 'other-extension',
      content: [
        { type: 'image', data: 'secret-image', mimeType: 'image/png' },
        { type: 'text', text: 'custom content' },
      ],
      display: false,
      timestamp: 4,
    },
    {
      role: 'bashExecution',
      command: 'echo hello',
      output: 'shell output',
      exitCode: 1,
      cancelled: false,
      truncated: false,
      timestamp: 5,
    },
    {
      role: 'bashExecution',
      command: 'hidden command',
      output: 'hidden output',
      exitCode: undefined,
      cancelled: true,
      truncated: false,
      excludeFromContext: true,
      timestamp: 6,
    },
    {
      role: 'branchSummary',
      summary: 'branch summary',
      fromId: null,
      timestamp: 7,
    },
    {
      role: 'compactionSummary',
      summary: 'old summary',
      tokensBefore: 10,
      timestamp: 8,
    },
  ]
  const text = serializeConversation(messages)
  for (const expected of [
    'user goal',
    'visible answer',
    '[call edit]',
    'START',
    'END',
    'HEAD',
    'TAIL',
    'characters truncated',
    'error=true',
    'image omitted',
    'custom content',
    'shell output',
    'exit=1',
    'branch summary',
    'old summary',
  ]) {
    expect(text).toContain(expected)
  }
  for (const omitted of [
    'system checkpoint',
    'private reasoning',
    'opaque signature',
    'secret-image',
    'hidden command',
    'hidden output',
  ]) {
    expect(text).not.toContain(omitted)
  }
  expect(text.length).toBeLessThan(5000)
})
