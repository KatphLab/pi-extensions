import { resolve } from 'node:path'

interface Metric {
  hit: number
  total: number
  percent: number | null
}

function metric(hit: number, total: number): Metric {
  return {
    hit,
    total,
    percent: total === 0 ? null : Math.round((hit / total) * 10_000) / 100,
  }
}

function readMetric(fields: Map<string, string>, key: 'L' | 'FN'): Metric {
  const total = Number(fields.get(`${key}F`))
  const hit = Number(fields.get(`${key}H`))
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(hit) ||
    hit < 0 ||
    total < hit
  )
    throw new Error('Invalid LCOV coverage counts. Run bun run test:ci again.')
  return metric(hit, total)
}

function uncoveredRanges(record: string): string[] {
  const lines = [...record.matchAll(/^DA:(\d+),0(?:,|\r?$)/gm)].map((match) =>
    Number(match[1]),
  )
  const sorted = [...new Set(lines)].sort((a, b) => a - b)
  const ranges: string[] = []
  for (let index = 0; index < sorted.length; index++) {
    const start = sorted[index]
    let end = start
    while (sorted[index + 1] === Number(end) + 1) end = sorted[++index]
    ranges.push(start === end ? `${start}` : `${start}-${end}`)
  }
  return ranges
}

/** Summarize existing LCOV data; this does not run tests or enforce coverage gates. */
export function coverageSummary(source: string, file?: string) {
  if (!source.trimEnd().endsWith('end_of_record'))
    throw new Error(
      'Missing or incomplete LCOV report. Run bun run test:ci again.',
    )
  const records = source
    .split('end_of_record')
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const fields = new Map(
        record
          .trim()
          .split(/\r?\n/)
          .map((line) => {
            const colon = line.indexOf(':')
            return [line.slice(0, colon), line.slice(colon + 1)]
          }),
      )
      const path = fields.get('SF')
      if (!path) throw new Error('LCOV record is missing its source file.')
      return {
        file: path,
        lines: readMetric(fields, 'L'),
        functions: readMetric(fields, 'FN'),
        record,
      }
    })
  if (file !== undefined) {
    const selected = records.find(
      (record) => resolve(record.file) === resolve(file),
    )
    if (!selected)
      throw new Error(
        `File not found in coverage report: ${file}. Run bun run test:ci to refresh it.`,
      )
    return {
      file: selected.file,
      lines: selected.lines,
      functions: selected.functions,
      uncoveredLines: uncoveredRanges(selected.record),
    }
  }
  const totals = {
    linesHit: 0,
    linesTotal: 0,
    functionsHit: 0,
    functionsTotal: 0,
  }
  for (const record of records) {
    totals.linesHit += record.lines.hit
    totals.linesTotal += record.lines.total
    totals.functionsHit += record.functions.hit
    totals.functionsTotal += record.functions.total
  }
  return {
    files: records.length,
    lines: metric(totals.linesHit, totals.linesTotal),
    functions: metric(totals.functionsHit, totals.functionsTotal),
  }
}
