import type { Configuration } from 'lint-staged'

export default {
  '*.{ts,mts,cts,js,mjs,cjs,json,jsonc,css,md}':
    'biome check --write --error-on-warnings --no-errors-on-unmatched',
} satisfies Configuration
