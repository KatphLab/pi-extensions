import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
export const source = `schema: 1
kind: dag
name: fixture
goal: Deliver a checked report
criteria: {proof: The output supports the goal}
defaults: {profile: coding, skills: [research]}
review: {profile: reasoning}
nodes:
  producer:
    kind: agent
    task: Inspect the fixture and write evidence
    satisfies: [proof]
    outputs: [findings.md]
  consumer:
    kind: agent
    task: Consume the report
    profile: reasoning
    needs: [producer]
    skills: []
  command:
    kind: command
    needs: [producer]
    argv: [bun, --version]
`
export function namedValue<T>(
  values: Readonly<Record<string, T>>,
  name: string,
): T | undefined {
  return Object.entries(values).find(([key]) => key === name)?.[1]
}
export const profileSource = `profiles:
  coding: {model: local/small/model, size: small}
  reasoning: {model: local/large, size: large}
`
export async function fixture(authenticated = true) {
  const root = await mkdtemp(join(tmpdir(), 'definition-'))
  await mkdir(join(root, 'research'))
  await writeFile(
    join(root, 'research/SKILL.md'),
    '---\nname: research\ndescription: Inspect local evidence\n---\nUse the fixture facts.\n',
  )
  await writeFile(join(root, 'AGENTS.md'), 'Keep fixture changes bounded.\n')
  await writeFile(join(root, 'profiles.yaml'), profileSource)
  await writeFile(join(root, 'dag.yaml'), source)
  const resources = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, 'agent'),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalSkillPaths: [join(root, 'research')],
  })
  await resources.reload()
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(root, 'models'),
    refreshOnCreate: false,
  })
  modelRuntime.registerProvider('local', {
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1',
    ...(authenticated ? { apiKey: 'fixture-only' } : {}),
    models: ['small/model', 'large'].map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 512,
    })),
  })
  return {
    root,
    resources,
    modelRuntime,
    paths: {
      projectRoot: root,
      definitionPath: 'dag.yaml',
      profilesPath: 'profiles.yaml',
    },
  }
}
