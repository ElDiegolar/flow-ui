/**
 * Every command the daemon can spawn, one module each, grouped by domain.
 * This barrel lets callers (sessions.ts) pull in the builders without a line
 * per file.
 */
export { buildAgentInvocation } from './agent/index.ts'
export { switchBranch } from './git/branch.ts'
export { buildGitCommitInvocation } from './git/commit.ts'
