import '@swc/core'
import type { IConfiguration } from 'dependency-cruiser'

export default {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'not-to-spec',
      severity: 'error',
      from: {},
      to: { path: '[.](?:spec|test)[.](?:js|mjs|cjs|ts|mts|cts)$' },
    },
    {
      name: 'app-code-not-to-test-folder',
      severity: 'error',
      from: { path: '^src/(?!__tests__/).+' },
      to: { path: '^src/__tests__/.+' },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      from: {
        path: '^src',
        pathNot: '[.](?:spec|test)[.](?:js|mjs|cjs|ts|mts|cts)$|test-utils/',
      },
      to: {
        dependencyTypes: ['npm-dev'],
        dependencyTypesNot: ['type-only', 'npm-peer'],
        pathNot: ['node_modules/@types/'],
      },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    exclude: String.raw`^\.worktrees/`,
    parser: 'swc',
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['main', 'types', 'typings'],
    },
    skipAnalysisNotInRules: true,
  },
} satisfies IConfiguration
