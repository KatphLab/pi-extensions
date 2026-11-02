import { describe, expect, it, spyOn } from 'bun:test'

describe('index', () => {
  it('writes greeting and farewell to stdout', async () => {
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(
      () => true,
    )

    await import('../index.js')

    expect(writeSpy).toHaveBeenCalledTimes(2)
    expect(writeSpy).toHaveBeenNthCalledWith(1, 'Hello, World!\n')
    expect(writeSpy).toHaveBeenNthCalledWith(2, 'Goodbye, World!\n')

    writeSpy.mockRestore()
  })
})
