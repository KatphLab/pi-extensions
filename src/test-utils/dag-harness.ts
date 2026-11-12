import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

export type FixtureAction =
  | { readonly tool: string; readonly arguments: Record<string, unknown> }
  | { readonly text: string }
  | { readonly status: number }
  | { readonly wait: Promise<void> }

export type FixtureScript =
  | readonly FixtureAction[]
  | ((body: unknown) => FixtureAction | Promise<FixtureAction>)

/** A wire fixture: every scripted tool call is executed by the actual SDK. */
export async function createDagHarness(
  actions: FixtureScript,
  reasoning = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'dag-sdk-'))
  const cwd = join(root, 'worktree')
  const artifacts = join(root, 'attempt', 'artifacts')
  const git = async (argv: string[]) => {
    const process = Bun.spawn(['git', ...argv], {
      cwd: root,
      env: { ...globalThis.process.env, GIT_MASTER: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    if (exit !== 0) throw new Error(`Fixture git failed: ${stderr}`)
    return stdout.trim()
  }
  await git(['init', '--quiet', join(root, 'repo')])
  await git([
    '-C',
    join(root, 'repo'),
    '-c',
    'user.name=SDK fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'test(dag): initialize isolated SDK fixture',
    '--trailer',
    'Co-authored-by: sisyphus-dev-ai <sisyphus-dev-ai@users.noreply.github.com>',
  ])
  await git([
    '-C',
    join(root, 'repo'),
    'worktree',
    'add',
    '--quiet',
    '--detach',
    cwd,
  ])
  const revision = await git(['-C', cwd, 'rev-parse', 'HEAD'])
  await mkdir(artifacts, { recursive: true })
  const { server, requests, requested, nextRequest } = serveFixture(actions)
  const runtime = await ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(root, 'catalog'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  runtime.registerProvider('dag-fixture', {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    api: 'openai-completions',
    apiKey: randomBytes(32).toString('hex'),
    models: [
      {
        id: 'fixture',
        name: 'Local deterministic fixture',
        reasoning,
        input: ['text'],
        contextWindow: 32_768,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  })
  return {
    root,
    cwd,
    artifacts,
    runtime,
    requests,
    revision,
    requested: requested.promise,
    nextRequest,
    endpoint: `http://127.0.0.1:${server.port}/v1`,
    sessionsDirectory: join(root, 'sessions'),
    async close() {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }
}

function serveFixture(actions: FixtureScript) {
  const requests: unknown[] = []
  const requested = Promise.withResolvers<void>()
  const waiting: (() => void)[] = []
  const nextRequest = () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve)
    })
  let index = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/chat/completions')
        return new Response('fixture route only', { status: 404 })
      const body: unknown = await request.json()
      requests.push(body)
      requested.resolve()
      for (const resolve of waiting.splice(0)) resolve()
      const action =
        typeof actions === 'function' ? await actions(body) : actions[index]
      index += 1
      return fixtureResponse(action, index)
    },
  })
  return { server, requests, requested, nextRequest }
}

function pausedResponse(wait: Promise<void>): Response {
  let active = true
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"id":"waiting","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"waiting"},"finish_reason":null}]}\n\n',
        ),
      )
      void wait.then(() => {
        if (active) controller.close()
      })
    },
    cancel() {
      active = false
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function fixtureResponse(
  action: FixtureAction | undefined,
  index: number,
): Response {
  if (!action) return new Response('Script exhausted', { status: 500 })
  if ('status' in action)
    return new Response('Fixture request failure', {
      status: action.status,
    })
  if ('wait' in action) return pausedResponse(action.wait)
  const delta =
    'tool' in action
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${index}`,
              type: 'function',
              function: {
                name: action.tool,
                arguments: JSON.stringify(action.arguments),
              },
            },
          ],
        }
      : { role: 'assistant', content: action.text }
  const chunk = (value: unknown, finish_reason: string | null) =>
    `data: ${JSON.stringify({ id: `chat_${index}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`
  return new Response(
    chunk(delta, null) +
      chunk({}, 'tool' in action ? 'tool_calls' : 'stop') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
