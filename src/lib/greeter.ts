export interface GreetingOptions {
  readonly name: string
  readonly greeting?: string
}

export const buildGreeting = (options: GreetingOptions): string => {
  const { name, greeting = 'Hello' } = options
  return `${greeting}, ${name}!`
}

export const buildFarewell = (name: string): string => {
  return `Goodbye, ${name}!`
}
