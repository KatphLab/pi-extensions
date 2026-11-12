import {
  type ProfileThinkingLevel,
  resolveProfileModel,
} from '@dag/definition/model.js'
import { DefinitionError, type Profiles } from '@dag/definition/schema.js'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

async function probeModel(
  runtime: ModelRuntime,
  candidate: {
    id: string
    model: ReturnType<ModelRuntime['getPhysicalModel']>
    thinkingLevel: ProfileThinkingLevel
    authenticated: boolean
  },
  signal: AbortSignal,
): Promise<void> {
  try {
    if (!candidate.model || !candidate.authenticated)
      throw new Error('Model unavailable')
    const response = await runtime.completeSimple(
      candidate.model,
      {
        messages: [
          { role: 'user', content: 'Reply OK.', timestamp: Date.now() },
        ],
      },
      {
        maxTokens: 16,
        ...(candidate.thinkingLevel === 'off'
          ? {}
          : { reasoning: candidate.thinkingLevel }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      },
    )
    if (response.stopReason === 'error' || response.stopReason === 'aborted')
      throw new Error(response.errorMessage ?? response.stopReason)
  } catch (value) {
    throw new DefinitionError(
      'model-probe',
      candidate.id,
      `Model request probe failed for ${candidate.id}; check authentication and endpoint model support.`,
      { cause: value instanceof Error ? value : new Error(String(value)) },
    )
  }
}

/** Catalog/auth discovery is not proof that an endpoint accepts a model. */
export async function modelReadiness(
  runtime: ModelRuntime,
  profiles: Profiles,
  probe: boolean,
  signal: AbortSignal,
) {
  const available = await runtime.getAvailable()
  const checks = []
  for (const id of new Set(
    Object.values(profiles).map((profile) => profile.model),
  )) {
    const resolved = resolveProfileModel(id, runtime)
    const authenticated = available.some(
      (candidate) =>
        candidate.provider === resolved.provider &&
        candidate.id === resolved.modelId,
    )
    if (probe)
      await probeModel(runtime, { ...resolved, id, authenticated }, signal)
    checks.push({
      model: id,
      catalog: resolved.model ? 'listed' : 'missing',
      credentials: authenticated ? 'resolved' : 'unavailable',
      request: probe ? 'succeeded' : 'not-probed',
    })
  }
  return {
    readiness: probe ? 'request-verified' : 'configuration-ready',
    models: checks,
  }
}
