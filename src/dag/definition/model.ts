import type { ModelRuntime, ScopedModel } from '@earendil-works/pi-coding-agent'
import { compile, oneOf } from '@earendil-works/pi-schema'

export type ProfileThinkingLevel = NonNullable<ScopedModel['thinkingLevel']>

const thinkingLevelSchema = compile(
  oneOf(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
)

/** Exact catalog IDs win over the optional final thinking suffix, as in Pi. */
export function resolveProfileModel(
  reference: string,
  runtime: Pick<ModelRuntime, 'getPhysicalModel'>,
) {
  const slash = reference.indexOf('/')
  const provider = reference.slice(0, slash)
  let modelId = reference.slice(slash + 1)
  let model = runtime.getPhysicalModel(provider, modelId)
  let thinkingLevel: ProfileThinkingLevel = 'off'
  const colon = modelId.lastIndexOf(':')
  const suffix = modelId.slice(colon + 1)
  if (!model && colon >= 0 && thinkingLevelSchema.check(suffix)) {
    modelId = modelId.slice(0, colon)
    thinkingLevel = suffix
    model = runtime.getPhysicalModel(provider, modelId)
  }
  return { provider, modelId, model, thinkingLevel }
}
