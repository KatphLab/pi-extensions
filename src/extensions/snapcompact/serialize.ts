import type { ContextEvent } from '@earendil-works/pi-coding-agent'

type Message = ContextEvent['messages'][number]

interface Block {
  type: string
  text?: string
  name?: string
  arguments?: unknown
}

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.6)
  return `${text.slice(0, head)} [${text.length - limit} characters truncated] ${text.slice(-(limit - head))}`
}

function blockText(block: Block): string {
  switch (block.type) {
    case 'text':
      return block.text ?? ''
    case 'toolCall':
      return `[call ${block.name ?? 'tool'}] ${cap(JSON.stringify(block.arguments ?? {}), 2000)}`
    case 'image':
      return '[image omitted]'
    default:
      return '' // Never replay thinking or opaque provider signatures.
  }
}

function contentText(content: string | Block[]): string {
  return typeof content === 'string'
    ? content
    : content.map(blockText).filter(Boolean).join('\n')
}

function messageText(message: Message): string {
  switch (message.role) {
    case 'system':
      return '' // Pi retains the complete system checkpoint separately.
    case 'branchSummary':
    case 'compactionSummary':
      return `[Earlier summary] ${message.summary}`
    case 'bashExecution':
      return message.excludeFromContext
        ? ''
        : `[Shell ${cap(message.command, 500)}; exit=${message.exitCode ?? 'unknown'}; cancelled=${message.cancelled}] ${cap(message.output, 2000)}`
    case 'toolResult':
      return `[Tool ${message.toolName}; error=${message.isError}] ${cap(contentText(message.content), 2000)}`
    default:
      return `[${message.role}] ${contentText(message.content)}`
  }
}

/** OMP-style bounded tool serialization, using only public host message contracts. */
export function serializeConversation(
  messages: ContextEvent['messages'],
): string {
  return messages.map(messageText).filter(Boolean).join('\n\n')
}
