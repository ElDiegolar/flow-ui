/**
 * Commit everything in one repo with a message from the Commit tab. Plain git,
 * no agent involved: `git add -A && git commit -m <message>`, run in the repo.
 * The message travels as a positional argument, never interpolated into the
 * shell string.
 */
import type { Invocation } from '../../common/types.ts'

export function buildGitCommitInvocation(
  repoPath: string,
  label: string,
  message: string,
): Invocation {
  return {
    label: `git commit ${label}`,
    command: 'sh',
    args: ['-c', 'git add -A && git commit -m "$1"', 'flow-commit', message],
    prompts: [],
    cwd: repoPath,
  }
}
