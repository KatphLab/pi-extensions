import { buildFarewell, buildGreeting } from '@lib/greeter.js'

const run = (): void => {
  const greeting = buildGreeting({ name: 'World' })
  process.stdout.write(`${greeting}\n`)

  const farewell = buildFarewell('World')
  process.stdout.write(`${farewell}\n`)
}

run()
