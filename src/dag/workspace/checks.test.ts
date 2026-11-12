import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import type { ArtifactIdentity } from '@dag/command.js'
import { acceptedInput } from './capabilities.js'
import { acceptContribution } from './contribution.js'
import {
  check,
  cleanupWorkspace,
  fixture,
  git,
  handoffProgress,
} from './test-fixture.js'
import type { ContributionRequest } from './types.js'

afterEach(cleanupWorkspace)
test.each(['started', 'unbound-observation'] as const)(
  'durable acceptance requires explicit repetition after losing %s evidence',
  async (fault) => {
    const request = fixture()
    fs.writeFileSync(join(request.worktree, 'allowed/edit'), 'accepted edit')
    const progressStore = handoffProgress(request.runner)
    const counter = join(request.runner, 'invocation-count.txt')
    const decisions = join(request.runner, 'repeat-decisions.jsonl')
    const approval = join(request.runner, 'repeat-authorized')
    let interrupt = true
    let repeats = 0
    const durable: NonNullable<ContributionRequest['durable']> = {
      read: progressStore.read,
      write: (progress) => {
        const selected =
          fault === 'started'
            ? progress.started.includes(1)
            : Boolean(progress.observations['1']?.length)
        if (interrupt && selected) {
          interrupt = false
          if (fault === 'started') progressStore.write(progress)
          throw new Error('lost check observation')
        }
        progressStore.write(progress)
      },
      repeat: (index, settled) => {
        repeats++
        if (!fs.existsSync(approval))
          throw new Error('repeat needs authorization')
        expect(index).toBe(1)
        expect(settled).toBeUndefined()
        fs.appendFileSync(decisions, `${JSON.stringify({ index })}\n`)
      },
    }
    const checks = ['completed', 'uncertain'].map((id) => ({
      id,
      argv: [
        process.execPath,
        '-e',
        `import * as fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(counter)}, ${JSON.stringify(`${id}\n`)})`,
      ],
    }))
    const submitted = { ...request, checks, durable, resumable: true }
    await expect(acceptContribution(submitted)).rejects.toMatchObject({
      cause: { message: 'lost check observation' },
    })
    const candidate = fs.readFileSync(join(request.runner, 'candidate.json'))
    const completed = durable.read().completed['0']
    if (!completed) throw new Error('missing completed check')
    const unboundPath = join(request.runner, 'check-1/observed-0.json')
    const unbound = fs.existsSync(unboundPath)
      ? JSON.parse(fs.readFileSync(unboundPath, 'utf8'))
      : undefined
    const retained = [
      completed.path,
      ...(unbound
        ? [
            unboundPath,
            ...unbound.evidence.map((entry: ArtifactIdentity) => entry.path),
          ]
        : []),
    ].map((path) => ({ path, bytes: fs.readFileSync(path) }))
    const before = fs.readFileSync(counter, 'utf8')
    const resumed = { ...submitted, resume: true }
    await expect(acceptContribution(resumed)).rejects.toMatchObject({
      cause: { message: 'repeat needs authorization' },
    })
    expect(repeats).toBe(1)
    expect(fs.readFileSync(counter, 'utf8')).toBe(before)
    fs.writeFileSync(
      approval,
      'Explicitly authorize repeating the uncertain check',
    )
    const accepted = await acceptContribution(resumed)
    expect(acceptedInput(accepted).contribution).toEqual(accepted)
    expect(fs.readFileSync(counter, 'utf8')).toBe(`${before}uncertain\n`)
    expect(repeats).toBe(2)
    for (const item of retained)
      expect(fs.readFileSync(item.path)).toEqual(item.bytes)
    expect(fs.readFileSync(join(request.runner, 'candidate.json'))).toEqual(
      candidate,
    )
    if (unbound) expect(accepted.receipts[1]).not.toBe(unbound.receipt)
    const published = await acceptContribution(resumed)
    expect(published).toEqual(accepted)
    expect(repeats).toBe(2)
    expect(fs.readFileSync(counter, 'utf8')).toBe(`${before}uncertain\n`)
    fs.appendFileSync(completed.path, '\n')
    await expect(acceptContribution(resumed)).rejects.toMatchObject({
      code: 'changed-check',
    })
    expect(repeats).toBe(2)
    expect(fs.readFileSync(counter, 'utf8')).toBe(`${before}uncertain\n`)
  },
)

test.each([
  { fault: 'receipt', code: 'changed-acceptance' },
  { fault: 'handoff', code: 'incomplete-publication' },
  { fault: 'ref', code: 'incomplete-publication' },
] as const)(
  'resuming a $fault damaged publication never mints trusted input or repeats checks',
  async ({ fault, code }) => {
    const request = fixture()
    const counter = join(request.runner, 'publication-check.txt')
    const checks = check(
      `import * as fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(counter)}, ${JSON.stringify('checked\n')})`,
    )
    const durable = {
      ...handoffProgress(request.runner),
      repeat: (): never => {
        throw new Error('completed check must never repeat')
      },
    }
    const accepted = await acceptContribution({
      ...request,
      checks,
      durable,
      resumable: true,
    })
    const candidate = fs.readFileSync(
      join(request.runner, 'candidate.json'),
      'utf8',
    )
    switch (fault) {
      case 'receipt':
        fs.appendFileSync(accepted.receipt, ' ')
        break
      case 'handoff':
        fs.renameSync(accepted.handoff, `${accepted.handoff}.missing`)
        break
      case 'ref':
        git(request.target.root, [
          'update-ref',
          accepted.acceptedRef,
          request.baseline,
        ])
        break
      default:
        throw new Error(fault satisfies never)
    }
    const progress = durable.read()
    await expect(
      acceptContribution({
        ...request,
        checks,
        durable,
        resumable: true,
        resume: true,
      }),
    ).rejects.toMatchObject({ code })
    expect(fs.readFileSync(counter, 'utf8')).toBe('checked\n')
    expect(
      fs.readFileSync(join(request.runner, 'candidate.json'), 'utf8'),
    ).toBe(candidate)
    expect(durable.read()).toEqual(progress)
    expect(git(request.target.root, ['rev-parse', 'HEAD'])).toBe(
      request.baseline,
    )
  },
)
