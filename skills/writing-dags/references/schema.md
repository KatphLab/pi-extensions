# DAG YAML reference

Use this reference while writing a standalone workflow. Use [CLI operations](../../../docs/dag-cli.md) only for installation, execution approval, composition, monitoring or recovery.

## Runtime and author responsibilities

The author owns the goal, observable criteria, task boundaries, input/output meaning, write authority, checks, stop conditions and failure handling. Neither a dependency nor an artifact declaration proves substantive adequacy.

The runtime enforces declared structure, scheduling, write scope, command results, output-file safety and evidence identities, with independent result review. It executes the checks the author declares; it does not infer domain schemas or completeness rules from prose. Workflow-specific guarantees belong in tasks, executable checks and semantic review criteria, not runtime special cases.

## Top-level fields

| Field            | Contract                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `kind` | Required: `schema: 1`, `kind: dag`.                                                                                                                                                       |
| `name`           | Required identifier. Identifiers start with a letter/digit and contain only letters, digits, `.`, `_`, `-`.                                                                               |
| `goal`           | Required nonempty outcome, not just an activity.                                                                                                                                          |
| `criteria`       | Required nonempty identifier-to-description map of observable acceptance conditions.                                                                                                      |
| `context`        | Optional shared task facts/instructions received by workers and automatic roles.                                                                                                          |
| `defaults`       | Optional `{profile, skills}` for agent nodes; node values override them. `skills: []` clears skill selection.                                                                             |
| `review`         | Required `{profile: name}` resolving to a large profile for independent result review.                                                                                                    |
| `integration`    | `{profile: name}` required whenever any node writes project files, including documentation. Omit for report-only work.                                                                    |
| `limits`         | Optional `concurrency` (default 1, minimum 1), `nodeRetries` (default 2 after the first attempt), `repairCycles` (default 3 after initial result review). Retry/repair limits allow zero. |
| `nodes`          | Required nonempty identifier-to-node map; dependencies must exist and be acyclic.                                                                                                         |
| `verify`         | Optional DAG-wide checks: `[{id, argv}]`.                                                                                                                                                 |

Each criterion must appear in a node's `satisfies`; delivering nodes need concrete checks or named output artifacts. The parser rejects uncovered criteria. Declaring responsibility is not proof of success.

## Node fields

Both node kinds support these common fields; omitted lists are empty:

| Field                             | Contract                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `needs`                           | Direct prerequisite node IDs. Use only for consumed outputs/code, not desired narrative order.                       |
| `references`                      | Required readable project-relative files. Resolve from the project root and must exist when that node becomes ready. |
| `write`                           | Allowed project-relative files or directory prefixes ending `/`, not globs. Artifact outputs are separate.           |
| `satisfies`                       | Criterion IDs this node delivers.                                                                                    |
| `outputs`                         | Named artifact paths inside the node's supplied artifacts directory.                                                 |
| `verify`                          | Optional checks: `[{id, argv}]`, with unique check IDs in that scope.                                                |
| `contextIndex`, `requiredContext` | Optional exact frozen-document lookups; see below.                                                                   |

An **agent node** has `kind: agent`, required nonempty `task`, and optional `profile` and `skills`. A profile must resolve from the node or defaults. Select a skill only when it is relevant and discoverable; the author conversation and unselected skills are not implicitly available.

Agent tools are bounded read/write/edit and `validate_submission`, not a shell or delegation interface. Provide explicit input paths; put command execution and executable checks in `argv`/`verify`. Workers receive frozen task context and accepted prerequisite handoffs, not a shared conversation or every ancestor transcript.

A **command node** has `kind: command` and required nonempty `argv`. Commands receive no model. `argv` executes an executable and its arguments without shell interpolation; shell operators in strings do not compose commands. The runner synthesizes command control reports from observed execution.

## Project paths and artifacts

Project writes are baseline-relative and scope-checked. Traversal, symlink escapes, Git internals, runtime roots and active authored definitions/configuration are protected. A `write` scope is not an OS sandbox or permission for unrelated external effects. Every installation, network effect or credential-dependent operation needs explicit authority.

Declare report/data outputs in `outputs`; direct producers to write them under their supplied artifacts directory. Consumers select accepted direct prerequisite artifacts by assignment and declared output, not guessed runtime paths. Their executable environment includes:

- `DAG_EVIDENCE_DIR`: this attempt's absolute artifacts directory.
- `DAG_INPUTS_FILE`: JSON array of accepted direct prerequisite artifacts, or an empty array. Each entry is `{assignment, path, artifact: {path, sha256, bytes}}`; `path` is the declared output name and `artifact.path` is its exact accepted location.

Agent consumers receive the same accepted identities in their frozen instructions. Leave prerequisite artifacts unchanged. Use project writes for files to integrate into the target checkout, not for intermediate reports.

The runner requires declared outputs to exist as regular files confined to the artifact directory and records their identities. It imposes no report headings or length limits. Put formatting and concision guidance in tasks, deterministic content checks in `verify`, and semantic adequacy in review criteria. `artifactContracts` is no longer supported.

## Agent completion and failure

Tasks must require `outcome.json` and `handoff.md` inside the supplied artifacts directory. They are control reports, not named outputs; do not declare them in `outputs` or write runner-owned receipts. JSON control reports are limited to 32 KiB; Markdown handoffs have no size limit.

- `outcome.json`: `outcome` is `claimed-complete`, `blocked` or `failed`; include `summary`, `deliverables`, `evidence: [{criterion, paths}]` and `findings: [{summary, evidence, needsAuthor}]`.
- Use exact single criterion IDs in evidence. Paths name declared outputs relative to artifacts, project files relative to the worktree, or absolute paths inside either. Cite upstream artifacts in Markdown instead of control-report evidence paths outside those roots.
- `handoff.md`: outcome, output locations, criterion evidence, consumed contracts and unresolved issues; link longer substantive artifacts/logs.
- Put the task's substantive results in declared artifacts. Use `needsAuthor` only for an actual missing input, authority or scope decision, not an ordinary domain finding.
- Require `validate_submission` after writing reports. It checks controls and evidence paths, not artifact content; it executes no commands and grants no acceptance. Runner checks and independent review remain separate.

The runtime retains interrupted resources and saved budgets. It does not silently authorize uncertain command repeats, replace missing resources or roll back integrated work. Describe domain-level failure expectations in the task; consult operations guidance when an actual run needs recovery.

## Profiles

Execution configuration is separate YAML with a `profiles` map. Each entry has `model: provider/model-id[:thinking]`, `size: small|large` and optional `description`. Use actual available/authenticated model IDs, not invented identifiers. Recognized thinking suffixes are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; a literal catalog ID takes precedence. Omitted thinking defaults to `off`; SDK support may clamp requested levels. A size label establishes neither capability nor price.

Use supplied configured profiles for workers, matching capability to the task, and a large profile for independent review. When comparing or proposing models, consult the [model benchmark reference](model-benchmarks.md); ordinary authoring need not repeat a model-selection study. Missing availability/authentication fails readiness without model substitution. Model probes incur calls and require authorization; ordinary validation is not an endpoint probe. Credentials remain in the host's authentication setup, not DAG YAML.

## Optional frozen-document lookups

Use this only when a task needs an exact already-frozen document and sections, rather than an ordinary reference:

```yaml
references: [inputs/protocol.md]
requiredContext: [protocol]
contextIndex:
  protocol:
    path: inputs/protocol.md
    sha256: "<actual lowercase SHA-256 of the file>"
    sections: [Scope, Inputs]
```

Replace the placeholder before validation. Relative paths reuse declared references; absolute paths can name an existing external frozen snapshot. The runtime validates readability, hash and exact headings before admission and acceptance. The lookup grants no parent-directory or write authority. Workers receive the exact readable path; unlisted ambient files are not automatically context.
