import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CommandRequest, commandClaim, executeCommand } from './command.js'
import { attemptLayout } from './state.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
function fixture(source: string): CommandRequest {
  const root = fs.mkdtempSync(join(tmpdir(), 'command-'))
  roots.push(root)
  const script = join(root, 'child.ts')
  fs.writeFileSync(script, source)
  return {
    ...attemptLayout(root, 'build', 0),
    cwd: root,
    argv: [process.execPath, script],
    identity: {
      runId: 'run-a',
      assignment: 'build',
      attempt: 0,
      revision: 'baseline-revision',
    },
    outputs: ['result.bin'],
    signal: new AbortController().signal,
  }
}
describe('owned checkpoints and argv commands', () => {
  test('observes literal argv, actual artifacts and runner-synthesized claim without worker reports', async () => {
    const request = fixture(
      `import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; writeFileSync(join(process.env.DAG_EVIDENCE_DIR, 'result.bin'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), evidence: process.env.DAG_EVIDENCE_DIR })); console.log('observed stdout'); console.error('observed stderr')`,
    )
    const literals = [
      '$HOME',
      '$(touch forbidden)',
      'a; echo forged',
      '*.ts',
      'white space',
      'quote"',
    ]
    const result = await executeCommand({
      ...request,
      argv: [...request.argv, ...literals],
    })
    expect(result.status).toBe('completed')
    expect(
      JSON.parse(
        fs.readFileSync(join(request.artifacts, 'result.bin'), 'utf8'),
      ),
    ).toEqual({ args: literals, cwd: request.cwd, evidence: request.artifacts })
    expect(result.identity).toEqual(request.identity)
    expect(fs.readFileSync(result.stdout, 'utf8')).toBe('observed stdout\n')
    expect(fs.readFileSync(result.stderr, 'utf8')).toBe('observed stderr\n')
    expect(commandClaim(result)).toEqual({
      outcome: 'claimed-complete',
      deliverables: [join(request.artifacts, 'result.bin')],
      receipt: result.receipt,
      revision: 'baseline-revision',
    })
    expect(fs.readdirSync(request.artifacts)).toEqual(['result.bin'])
    expect(fs.existsSync(join(request.cwd, 'forbidden'))).toBe(false)
    expect(fs.existsSync(join(result.receipt, '..', 'handoff.md'))).toBe(true)
  })
})
describe('ownership and command interruption', () => {
  test.each([
    {
      name: 'nonzero exit despite success logs',
      source: `console.log('ALL CHECKS PASSED'); process.exit(7)`,
      code: 7,
    },
    {
      name: 'missing required artifact',
      source: `console.log('done')`,
      code: 0,
    },
    {
      name: 'artifact symlink escape',
      source: `import { symlinkSync } from 'node:fs'; symlinkSync('/etc/hostname', process.env.DAG_EVIDENCE_DIR + '/result.bin')`,
      code: 0,
    },
  ])('retains failed evidence for $name', async ({ source, code }) => {
    const request = fixture(source)
    const result = await executeCommand(request)
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(code)
    expect(commandClaim(result).outcome).toBe('failed')
    expect(JSON.parse(fs.readFileSync(result.receipt, 'utf8')).status).toBe(
      'failed',
    )
  })
  test('rejects forged observations and changed artifact bytes', async () => {
    const request = fixture(
      `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.DAG_EVIDENCE_DIR + '/result.bin', 'original')`,
    )
    const result = await executeCommand(request)
    expect(() => commandClaim({ ...result })).toThrow('unobserved-receipt')
    fs.writeFileSync(join(request.artifacts, 'result.bin'), 'changed')
    expect(() => commandClaim(result)).toThrow('stale-artifact')
  })
  test('rejects a replaced on-disk receipt instead of publishing a false handoff', async () => {
    const request = fixture(
      `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.DAG_EVIDENCE_DIR + '/result.bin', 'original')`,
    )
    const result = await executeCommand(request)
    fs.writeFileSync(result.receipt, '{"status":"completed","exitCode":0}')
    expect(() => commandClaim(result)).toThrow('stale-receipt')
    expect(fs.existsSync(join(result.receipt, '..', 'handoff.md'))).toBe(false)
  })
  test('rejects changed accepted inputs before executing a consumer', async () => {
    const source = fixture(
      `await Bun.write(process.env.DAG_EVIDENCE_DIR + '/result.bin', '21')`,
    )
    const produced = await executeCommand(source)
    const artifact = produced.artifacts[0]
    if (!artifact) throw new Error('Missing source artifact')
    const request = fixture(
      `await Bun.write(process.env.DAG_EVIDENCE_DIR + '/result.bin', 'must not run')`,
    )
    fs.writeFileSync(artifact.path, '22')
    await expect(
      executeCommand({
        ...request,
        artifactInputs: [
          { assignment: 'source', path: 'result.bin', artifact },
        ],
      }),
    ).rejects.toMatchObject({ code: 'stale-input' })
    expect(fs.existsSync(join(request.artifacts, 'result.bin'))).toBe(false)
    fs.unlinkSync(artifact.path)
    fs.symlinkSync(join(request.cwd, 'child.ts'), artifact.path)
    await expect(
      executeCommand({
        ...request,
        artifactInputs: [
          { assignment: 'source', path: 'result.bin', artifact },
        ],
      }),
    ).rejects.toMatchObject({ code: 'stale-input' })
  })
  test.each(['source', 'manifest'])(
    'rejects a command that changes its %s input evidence',
    async (changed) => {
      const source = fixture(
        `await Bun.write(process.env.DAG_EVIDENCE_DIR + '/result.bin', '21')`,
      )
      const produced = await executeCommand(source)
      const artifact = produced.artifacts[0]
      if (!artifact) throw new Error('Missing source artifact')
      const request = fixture(`
      import { chmodSync, writeFileSync } from 'node:fs';
      const manifest = process.env.DAG_INPUTS_FILE;
      const inputs = await Bun.file(manifest).json();
      const path = ${JSON.stringify(changed)} === 'source' ? inputs[0].artifact.path : manifest;
      chmodSync(path, 0o600);
      writeFileSync(path, '[]');
      await Bun.write(process.env.DAG_EVIDENCE_DIR + '/result.bin', '42');
    `)
      const result = await executeCommand({
        ...request,
        artifactInputs: [
          { assignment: 'source', path: 'result.bin', artifact },
        ],
      })
      expect(result.status).toBe('failed')
      expect(result.error).toContain(
        changed === 'source' ? 'stale-input' : 'changed-input-manifest',
      )
      expect(commandClaim(result).outcome).toBe('failed')
    },
  )
  test('rejects reserved/traversing outputs before starting a process', async () => {
    const request = fixture(`throw new Error('must not start')`)
    for (const output of [
      '../runner/receipt.json',
      'outcome.json',
      '/absolute',
      'runner/file',
    ]) {
      await expect(
        executeCommand({ ...request, outputs: [output] }),
      ).rejects.toThrow('invalid-output')
    }
    expect(fs.readdirSync(request.runner)).toEqual([])
  })
  test('records an unusable executable as failed without replay', async () => {
    const request = fixture('')
    const result = await executeCommand({
      ...request,
      argv: [join(request.cwd, 'missing-binary')],
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('ENOENT')
    expect(fs.readdirSync(request.runner)).toHaveLength(1)
  })
  test('kills an owned child tree after exact descendant connection and keeps partial logs', async () => {
    const sockets = new Set<import('node:net').Socket>()
    const controller = new AbortController()
    let notifyStarted: () => void = () => {
      throw new Error('barrier not initialized')
    }
    let notifyClosed: () => void = () => {
      throw new Error('barrier not initialized')
    }
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const closed = new Promise<void>((resolve) => {
      notifyClosed = resolve
    })
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('data', () => {
        notifyStarted()
      })
      socket.once('close', () => {
        sockets.delete(socket)
        notifyClosed()
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('missing fixture address')
    const request = fixture(
      `import { spawn } from 'node:child_process'; import { connect } from 'node:net'; if (process.argv[2] === 'leaf') { const socket = connect(Number(process.argv[3]), '127.0.0.1', () => socket.write(String(process.pid))); } else { console.log('partial before cancellation'); spawn(process.execPath, [process.argv[1], 'leaf', process.argv[2]], { env: process.env, stdio: 'inherit' }); }`,
    )
    const execution = executeCommand({
      ...request,
      argv: [...request.argv, String(address.port)],
      signal: controller.signal,
    })
    try {
      await started
      controller.abort()
      controller.abort()
      const result = await execution
      await closed
      expect(result.status).toBe('interrupted')
      expect(result.exitCode).not.toBe(0)
      expect(fs.readFileSync(result.stdout, 'utf8')).toBe(
        'partial before cancellation\n',
      )
      expect(commandClaim(result).outcome).toBe('failed')
      expect(sockets.size).toBe(0)
      expect(fs.readdirSync(request.runner)).toHaveLength(1)
    } finally {
      controller.abort()
      await execution
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
  })
})
