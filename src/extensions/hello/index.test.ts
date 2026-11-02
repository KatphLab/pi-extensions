import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import helloExtension from './index.js'

const root = resolve(import.meta.dir, '../../..')
let directory: string
let runner: ExtensionRunner

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-extensions-'))
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [helloExtension],
  })
  await loader.reload()
  const loaded = loader.getExtensions()
  expect(loaded.errors).toEqual([])
  const models = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(directory, 'models'),
    refreshOnCreate: false,
  })
  runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    directory,
    SessionManager.inMemory(directory),
    new ModelRegistry(models),
  )
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('hello extension', () => {
  it.each([
    ['', 'world'],
    ['   ', 'world'],
    ['  Ada Lovelace  ', 'Ada Lovelace'],
  ])('greets %j without a model request', async (args, name) => {
    const notify = mock()
    runner.setUIContext({ ...runner.getUIContext(), notify }, 'tui')
    const command = runner.getCommand('hello')
    expect(command?.description).toContain('/hello [name]')
    if (!command) {
      throw new Error('The hello command was not registered')
    }
    await command.handler(args, runner.createCommandContext())
    expect(notify).toHaveBeenCalledWith(`Hello, ${name}!`, 'info')
  })

  it.each(['print', 'json'] as const)(
    'does not use UI in %s mode',
    async (mode) => {
      runner.setUIContext(undefined, mode)
      const notify = spyOn(runner.getUIContext(), 'notify')
      try {
        const command = runner.getCommand('hello')
        if (!command) {
          throw new Error('The hello command was not registered')
        }
        await command.handler('Ada', runner.createCommandContext())
        expect(notify).not.toHaveBeenCalled()
      } finally {
        notify.mockRestore()
      }
    },
  )
})

it('discovers a second extension without changing the package manifest', async () => {
  const fixture = join(directory, 'package')
  const first = join(fixture, 'src/extensions/hello')
  await mkdir(first, { recursive: true })
  await cp(join(root, 'package.json'), join(fixture, 'package.json'))
  await writeFile(
    join(first, 'index.ts'),
    'export default function firstExtension() {}\n',
  )

  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [fixture],
  })
  await loader.reload()
  expect(loader.getExtensions().errors).toEqual([])
  expect(
    loader.getExtensions().extensions.map((extension) => extension.path),
  ).toEqual([join(first, 'index.ts')])

  const second = join(fixture, 'src/extensions/second')
  await mkdir(second)
  await writeFile(
    join(second, 'index.ts'),
    'export default function secondExtension() {}\n',
  )
  await loader.reload()
  expect(loader.getExtensions().errors).toEqual([])
  const paths = loader
    .getExtensions()
    .extensions.map((extension) => extension.path)
  expect(paths).toHaveLength(2)
  expect(paths).toEqual(
    expect.arrayContaining([join(first, 'index.ts'), join(second, 'index.ts')]),
  )
})

it('loads the package manifest through Pi and discovers the hello entry point', async () => {
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [root],
  })
  await loader.reload()
  const loaded = loader.getExtensions()
  expect(loaded.errors).toEqual([])
  expect(loaded.extensions.map((extension) => extension.path)).toContain(
    join(root, 'src/extensions/hello/index.ts'),
  )
  expect(
    loaded.extensions.flatMap((extension) => [...extension.commands.keys()]),
  ).toContain('hello')
})
