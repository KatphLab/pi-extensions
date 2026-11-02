import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { buildArchive, getArchive, historyContent } from './archive.js'
import { type RenderFrame, renderFrame } from './render.js'

function reportRenderingFailure(thrown: unknown, ctx: ExtensionContext): void {
  const error =
    thrown instanceof Error
      ? thrown
      : new Error('Unknown bitmap rendering failure', { cause: thrown })
  console.error('Snapcompact rendering failed:', error)
  if (ctx.hasUI) {
    ctx.ui.notify(
      'Snapcompact could not render this history. Compaction cancelled; check the bundled font assets and try /compact again.',
      'error',
    )
  }
}

export default function snapcompactExtension(
  pi: ExtensionAPI,
  render: RenderFrame = renderFrame,
): void {
  let compacting = false
  const triggerCompaction = (ctx: ExtensionContext) => {
    if (compacting) return
    compacting = true
    ctx.compact({
      onComplete: () => {
        compacting = false
      },
      onError: (error) => {
        compacting = false
        console.error('Snapcompact failed:', error)
        if (ctx.hasUI)
          ctx.ui.notify(
            'Compaction failed. Check your model configuration and try /compact again.',
            'error',
          )
      },
    })
  }

  pi.on('turn_end', (_event, ctx) => {
    const percent = ctx.getContextUsage()?.percent
    if (percent != null && percent >= 70) triggerCompaction(ctx)
  })

  pi.on('session_before_compact', async (event, ctx) => {
    if (event.signal.aborted) return { cancel: true }
    const model = ctx.model
    if (!model?.input.includes('image')) {
      if (ctx.hasUI)
        ctx.ui.notify(
          'Snapcompact requires an image-capable model. Select one and try /compact again; compaction cancelled.',
          'error',
        )
      return { cancel: true }
    }
    const previous = event.branchEntries.findLast(
      (entry) => entry.type === 'compaction',
    )
    try {
      const compaction = await buildArchive(
        event.preparation,
        model,
        getArchive(previous?.details),
        render,
        event.signal,
      )
      return { compaction }
    } catch (thrown) {
      if (event.signal.aborted) return { cancel: true }
      reportRenderingFailure(thrown, ctx)
      return { cancel: true }
    }
  })

  // Reconstruct from the active branch on every request: no stale cache on /tree or /resume.
  pi.on('context', (event, ctx) => {
    const previous = ctx.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === 'compaction')
    const archive = getArchive(previous?.details)
    if (!archive) return
    return {
      messages: event.messages.map((message) => {
        if (
          message.role !== 'compactionSummary' ||
          message.summary !== previous?.summary
        )
          return message
        return {
          role: 'custom' as const,
          customType: 'snapcompact',
          content: historyContent(
            message.summary,
            archive,
            ctx.model?.input.includes('image') ?? false,
          ),
          display: false,
          timestamp: message.timestamp,
        }
      }),
    }
  })
}
