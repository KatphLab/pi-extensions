import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function helloExtension(pi: ExtensionAPI): void {
  pi.registerCommand('hello', {
    description: 'Show a greeting: /hello [name]',
    handler: (args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(`Hello, ${args.trim() || 'world'}!`, 'info')
      }
      return Promise.resolve()
    },
  })
}
