/**
 * Shared wiring for the two coding agents Flow drives (claude, codex): where
 * their binaries live, where codex keeps its auth, and the flags that let them
 * run un-attended.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { FlowConfig } from './types.ts'

// Autonomy flags passed through to the underlying CLI. The orchestrator drives
// sub-agents via send_input, so they must not stop on per-action approval gates.
//   claude: `--permission-mode bypassPermissions` runs fully non-interactive
//           with all tools allowed.
//   codex:  never prompt, sandboxed to workspace writes.
// Both are overridable via env in case a CLI version renames a flag, and the
// whole thing is gated by FLOW_AGENT_AUTONOMOUS (default on) — when off, the
// orchestrator falls back to answering prompts itself through send_input.
function envArgs(name: string, fallback: string[]): string[] {
  const v = process.env[name]
  if (v === undefined) return fallback
  return v.trim() ? v.trim().split(/\s+/) : []
}

// Auto-approval flags for the Codex CLI (0.143+). This is the explicit form of
// the old `--full-auto` shortcut, which current Codex rejects as an unknown
// argument (`error: unexpected argument '--full-auto'`).
export const CODEX_AUTONOMY_ARGS = ['--ask-for-approval', 'never', '--sandbox', 'workspace-write']

export function agentAutonomyArgs(agent: 'codex' | 'claude'): string[] {
  if (process.env.FLOW_AGENT_AUTONOMOUS === '0') return []
  return agent === 'codex'
    ? envArgs('FLOW_CODEX_AUTONOMY_ARGS', CODEX_AUTONOMY_ARGS)
    : envArgs('FLOW_CLAUDE_AUTONOMY_ARGS', ['--permission-mode', 'bypassPermissions'])
}

/** Absolute CODEX_HOME (holds codex auth + config). Shared by the orchestrator
 * and by codex sub-agents, which both spawn codex directly. */
export function codexHome(): string {
  return process.env.FLOW_CODEX_HOME ?? path.join(homedir(), '.codex')
}

/**
 * Resolve how to launch the Codex CLI: an explicit CODEX_BIN or config value,
 * then ~/.local/bin, then a `codex` on PATH, and finally `npx -y @openai/codex`
 * on demand. Returns the executable plus any leading args (npx needs the
 * package spec prepended).
 */
export function resolveCodex(config: FlowConfig): { command: string; prefixArgs: string[] } {
  const binaries = [config.codexBin, path.join(homedir(), '.local', 'bin', 'codex')].filter(
    (c): c is string => Boolean(c),
  )
  for (const bin of binaries)
    if (path.isAbsolute(bin) && existsSync(bin)) return { command: bin, prefixArgs: [] }
  const onPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((d) => path.join(d, 'codex'))
    .find((f) => existsSync(f))
  if (onPath) return { command: onPath, prefixArgs: [] }
  return { command: 'npx', prefixArgs: ['-y', '@openai/codex'] }
}
