import { join } from 'node:path'
import {
  DefaultResourceLoader,
  type ExtensionFactory,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'

export async function createExtensionHarness(
  directory: string,
  extensionFactories: ExtensionFactory[],
) {
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories,
  })
  await loader.reload()
  const loaded = loader.getExtensions()
  if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors))
  const models = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(directory, 'models'),
    refreshOnCreate: false,
  })
  const registry = new ModelRegistry(models)
  const session = SessionManager.inMemory(directory)
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    directory,
    session,
    registry,
  )
  return { runner, registry, session, runtime: loaded.runtime }
}
