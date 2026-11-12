import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverageSummary } from './coverage-summary.js'

const report = `TN:
SF:src/example.ts
FNF:2
FNH:1
DA:1,3
DA:8,0
DA:4,0,checksum
DA:2,0
DA:3,0
LF:5
LH:1
end_of_record
SF:src/covered.ts
FNF:1
FNH:1
DA:1,2
DA:2,1
LF:2
LH:2
end_of_record
SF:src/empty.ts
FNF:0
FNH:0
LF:0
LH:0
end_of_record
`

test('summarizes weighted counts and exposes only the requested file’s uncovered ranges', () => {
  expect(coverageSummary(report)).toEqual({
    files: 3,
    lines: { hit: 3, total: 7, percent: 42.86 },
    functions: { hit: 2, total: 3, percent: 66.67 },
  })
  expect(
    coverageSummary(report.replaceAll('\n', '\r\n'), resolve('src/example.ts')),
  ).toEqual({
    file: 'src/example.ts',
    lines: { hit: 1, total: 5, percent: 20 },
    functions: { hit: 1, total: 2, percent: 50 },
    uncoveredLines: ['2-4', '8'],
  })
  expect(coverageSummary(report, './src/empty.ts')).toEqual({
    file: 'src/empty.ts',
    lines: { hit: 0, total: 0, percent: null },
    functions: { hit: 0, total: 0, percent: null },
    uncoveredLines: [],
  })
  expect(() => coverageSummary(report, 'src/missing.ts')).toThrow(
    'File not found',
  )
})

test.each([
  { source: '', error: 'Missing or incomplete LCOV report' },
  {
    source: report.replace('SF:src/example.ts', 'TN:'),
    error: 'missing its source file',
  },
  {
    source: report.replace('LF:5\n', ''),
    error: 'Invalid LCOV coverage counts',
  },
  {
    source: report.replace('LH:1', 'LH:6'),
    error: 'Invalid LCOV coverage counts',
  },
])('rejects unusable reports: $error', ({ source, error }) => {
  expect(() => coverageSummary(source)).toThrow(error)
})

test('CLI emits one JSON line and actionable failures without rerunning tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-summary-'))
  const script = fileURLToPath(
    new URL('../../scripts/coverage-summary.ts', import.meta.url),
  )
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, script, ...args], { cwd: root })
  try {
    const missing = run()
    expect(missing.exitCode).toBe(1)
    expect(missing.stdout.toString()).toBe('')
    expect(missing.stderr.toString()).toContain('Run bun run test:ci first.')
    mkdirSync(join(root, 'coverage'))
    writeFileSync(join(root, 'coverage/lcov.info'), report)
    const summary = run()
    expect(summary.exitCode).toBe(0)
    expect(summary.stderr.toString()).toBe('')
    expect(summary.stdout.toString()).toBe(
      `${JSON.stringify(coverageSummary(report))}\n`,
    )
    const selected = run('src/example.ts')
    expect(selected.exitCode).toBe(0)
    expect(JSON.parse(selected.stdout.toString())).toMatchObject({
      file: 'src/example.ts',
      uncoveredLines: ['2-4', '8'],
    })
    const invalid = run('src/example.ts', 'src/covered.ts')
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stderr.toString()).toContain(
      'Usage: bun run coverage:summary',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
