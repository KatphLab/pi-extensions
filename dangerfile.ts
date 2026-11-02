import { danger, fail, schedule, warn } from 'danger'

const { created_files, modified_files, deleted_files } = danger.git

const MAX_FILES_CHANGED = 20
const MAX_LINES_CHANGED = 1200
const MAX_DELETIONS = 400
const MAX_ADDITIONS = 1000

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
  /\/__mocks__\//,
  /\.test\.ts\.snap$/,
]

const isTestFile = (filePath: string): boolean =>
  TEST_FILE_PATTERNS.some((pattern) => pattern.test(filePath))

const sourceFiles = [
  ...created_files,
  ...modified_files,
  ...deleted_files,
].filter((file) => !isTestFile(file))

const filesChangedCount = sourceFiles.length

const countLines = (text: string): number => {
  if (!text) {
    return 0
  }

  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

const runSizeChecks = async (): Promise<void> => {
  let additions = 0
  let deletions = 0

  for (const file of sourceFiles) {
    const diff = await danger.git.diffForFile(file)
    if (diff) {
      additions += countLines(diff.added)
      deletions += countLines(diff.removed)
    }
  }

  const totalChanges = additions + deletions

  if (filesChangedCount > MAX_FILES_CHANGED) {
    fail(
      `PR is too large: ${filesChangedCount} files changed. Limit is ${MAX_FILES_CHANGED}. Split it into smaller PRs.`,
    )
  }

  if (totalChanges > MAX_LINES_CHANGED) {
    fail(
      `PR is too large: ${totalChanges} lines changed (${additions} additions, ${deletions} deletions). Limit is ${MAX_LINES_CHANGED}.`,
    )
  }

  if (additions > MAX_ADDITIONS) {
    fail(`Too many additions: ${additions}. Limit is ${MAX_ADDITIONS}.`)
  }

  if (deletions > MAX_DELETIONS) {
    warn(`Large deletion set: ${deletions}. Limit is ${MAX_DELETIONS}.`)
  }
}

schedule(runSizeChecks())

const blockedPatterns = [
  /^dist\//,
  /^build\//,
  /package-lock\.json$/,
  /\.tsbuildinfo$/,
]

const blockedFiles = [...created_files, ...modified_files].filter((file) =>
  blockedPatterns.some((pattern) => pattern.test(file)),
)

if (blockedFiles.length > 0) {
  fail(
    `Do not include generated/build artifacts in PRs:\n- ${blockedFiles.join('\n- ')}`,
  )
}
