export class RunError extends Error {
  constructor(
    readonly code: string,
    readonly resource: string,
    options?: ErrorOptions,
  ) {
    super(
      `${code}: inspect ${resource}; work and evidence are retained`,
      options,
    )
    this.name = 'RunError'
  }
}
