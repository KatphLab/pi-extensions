import { readFileSync } from 'node:fs'
import { coverageSummary } from '@utils/coverage-summary.js'

try {
  const args = process.argv.slice(2)
  if (args.length > 1 || args[0]?.startsWith('-'))
    throw new Error('Usage: bun run coverage:summary [source-file]')
  let source: string
  try {
    source = readFileSync('coverage/lcov.info', 'utf8')
  } catch (cause) {
    throw new Error(
      'Cannot read coverage/lcov.info. Run bun run test:ci first.',
      {
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      },
    )
  }
  process.stdout.write(`${JSON.stringify(coverageSummary(source, args[0]))}\n`)
} catch (cause) {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
