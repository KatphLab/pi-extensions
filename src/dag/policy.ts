import type { DagDefinition, WorkerReport } from '@dag/definition/schema.js'

export function executableNodes(nodes: DagDefinition['nodes']) {
  return Object.fromEntries(
    Object.entries(nodes).map(([id, node]) => [
      id,
      {
        ...node,
        ...('task' in node ? { task: undefined } : {}),
        references: undefined,
      },
    ]),
  )
}

export function reportPaths(report: WorkerReport): readonly string[] {
  return [
    ...report.deliverables,
    ...report.evidence.flatMap((item) => item.paths),
    ...report.findings.flatMap((item) => item.evidence),
  ]
}
