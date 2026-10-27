/**
 * AI Setup: one button that has a Claude session configure the workspace for
 * the developer. The session scans a folder of git repos, links them under
 * `<workspace>/projects/<category>/<repo>` (symlinks, nothing moved), and writes
 * flow.config.json, AGENTS.md and standards/ so nobody has to learn the layout
 * in docs/HANDOFF.md §0. The prompt below IS the feature: it is the whole
 * instruction set the agent follows, so keep each step concrete and checkable.
 */
import { mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { agentAutonomyArgs } from './common/agents.ts'
import { getConfig } from './common/config.ts'
import { startSession } from './pty.ts'
import type { RouteContext } from './routes/context.ts'

export class AiSetupError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AiSetupError'
  }
}

export type AiSetupBody = { scanPath?: string; workspace?: string }

/** `~/x` → the home folder, then the path must be absolute. */
function absolute(input: string, label: string): string {
  const expanded =
    input === '~' || input.startsWith('~/') ? path.join(homedir(), input.slice(1)) : input
  if (!path.isAbsolute(expanded)) throw new AiSetupError(400, `${label} must be an absolute path`)
  return path.resolve(expanded)
}

/** The instruction set the setup agent follows. Paths are interpolated; the
 * token is never written here: the agent reads it from $FLOW_TOKEN. */
export function buildAiSetupPrompt(opts: { scanPath: string; workspace: string }): string {
  const { scanPath, workspace } = opts
  const name = path.basename(scanPath)
  return `You are setting up a Flow workspace for a developer. Flow is a local app that shows a folder of git repositories grouped into categories and runs coding agents over them. Your job is to build that folder layout for them. Do not move or change their code.

PATHS
- SCAN folder (the developer's code): "${scanPath}"
- WORKSPACE (the only place you may write): "${workspace}"
- Flow daemon: $FLOW_URL. Every request to it needs the header X-Flow-Token: $FLOW_TOKEN (read it from the environment; never print the token value).

RULES
1. Never move, copy, rename, or edit anything under the SCAN folder. Never run git commands that change state (no commit, checkout, switch, pull, fetch, stash, reset, clean). Read-only git is fine: git -C <repo> remote -v, git -C <repo> branch --show-current, git -C <repo> branch -a, git -C <repo> log -20 --oneline.
2. Create and write files only inside the WORKSPACE. The symlinks live inside the WORKSPACE and point at the repos.
3. Do not install packages and do not run package managers (npm, pnpm, yarn, pip, uv, poetry, bundle, cargo, go, make), builds, tests, dev servers, or docker.
4. Do not invent facts. If you cannot tell what a repo is, classify it as "other" and say so in the summary.
5. Keep progress messages short. Use only the shell and file tools.

STEP 1: FIND THE REPOS
Run: find "${scanPath}" -maxdepth 4 -name .git -not -path "*/node_modules/*" -not -path "*/vendor/*"
Each hit is ".../<repo>/.git". The repo directory is the path without the trailing "/.git". Do not descend into a repo to look for nested repos. If the search finds no repos, write nothing, say so in the summary, and stop.

STEP 2: CLASSIFY THE REPOS INTO CATEGORIES
- Use 2 to 6 categories. Good names describe what the code is: frontend, backend, service, library, infra, docs, tooling, other. Use the developer's own names when their folders already group repos (for example SCAN/web/app and SCAN/web/admin mean a category "web"). Category names: lower case, letters, digits and dashes only.
- Evidence, in this order: folder names above the repo, package manifests (package.json, pyproject.toml, go.mod, Cargo.toml, pom.xml, *.tf, Dockerfile), and the first 60 lines of README.md. Every category you choose must be backed by something you read.
- A repo belongs to exactly one category.

STEP 3: LINK THE REPOS
For each repo, create WORKSPACE/projects/<category>/<repo>:
- mkdir -p "${workspace}/projects/<category>"
- ln -s "<absolute path of the original repo>" "${workspace}/projects/<category>/<repo>"
- <repo> is the folder's base name, lower case, with spaces and underscores replaced by dashes. If two repos would get the same name in one category, append -2 to the second.
- Never use cp, mv, git clone, or rsync. Never create a link that points anywhere except a repo you found in Step 1.
- If the path already exists and is a link to the same repo, leave it. If something else is there, do not touch it; report it.
- Check each link with: readlink -f "<link>" and confirm it resolves to the repo.

STEP 4: WRITE flow.config.json
Write WORKSPACE/flow.config.json with exactly these keys and no others:
{ "name": "${name}", "projectsDir": "projects" }
Leave out "categories" so that Flow discovers categories from the folders.

STEP 5: WRITE AGENTS.md AND CLAUDE.md
Write WORKSPACE/AGENTS.md (under 150 lines):
- A title "# ${name} workspace" and one sentence: repos live under projects/<category>/<repo> as symlinks to their real location, so edit them there.
- One section per category: "## <category>", then one paragraph on what the repos in it are, citing the file that tells you (README.md, package.json and so on).
- Where a README or package.json script says how to run the tests or the dev server, name the file and the command. Do not run it.
- The branch naming you observe (from git branch output). If there is no clear pattern, write "No branch naming pattern is evident."
- Do not invent facts. Anything you could not confirm, leave out.
Write WORKSPACE/CLAUDE.md with the single line: @AGENTS.md

STEP 6: WRITE THE STANDARDS
For each category, write WORKSPACE/standards/<category>.md. Start the file with this frontmatter, then the body:
---
applies: [<category>]
---
# <Category> standards
Then 5 to 10 bullets. Each bullet is a rule you can see in the code, with the file that shows it in brackets, for example: "Format with Prettier, single quotes, no semicolons (.prettierrc)". Good sources: lint and formatter configs, editorconfig, the test folder layout, the commit message style in git log, and the package scripts. Do not write a rule you did not see. If nothing is evident for a category, do not create its file.

STEP 7: TELL FLOW ABOUT THE NEW FILES AND BUILD THE CODE GRAPHS
a) Reload the configuration:
   curl -sS -X POST "$FLOW_URL/api/config/reload" -H "X-Flow-Token: $FLOW_TOKEN"
   The reply names the workspace. If it does not name "${workspace}", say so in the summary.
b) Start the code-graph build for every repo. It runs in the background, so do not wait for it:
   curl -sS -X POST "$FLOW_URL/api/code-graph/build" -H "X-Flow-Token: $FLOW_TOKEN" -H "Content-Type: application/json" -d '{"all":true}'
c) Check the project list:
   curl -sS "$FLOW_URL/api/projects" -H "X-Flow-Token: $FLOW_TOKEN"
   Confirm every category and every repo you linked appears in it. If one is missing, check the link and the flow.config.json, fix it if it is yours to fix, and report it.

STEP 8: SUMMARY
End with a short message of at most 15 lines:
- the categories, with the repo count in each
- the files you wrote
- repos you skipped or left alone, and why
- anything you were unsure about, such as a classification you guessed
Then stop. Do nothing else.`
}

/** Validate the request, make sure the workspace folder exists, and start the
 * setup session in the workspace with the scan folder granted via --add-dir. */
export function startAiSetup(
  ctx: Pick<RouteContext, 'daemonUrl' | 'token'>,
  body: AiSetupBody,
): { id: string; label: string } {
  if (typeof body.scanPath !== 'string' || !body.scanPath.trim()) {
    throw new AiSetupError(400, 'scanPath required')
  }
  const scanPath = absolute(body.scanPath.trim(), 'scanPath')
  const config = getConfig()
  const workspace = absolute(
    body.workspace?.trim() || config.workspace || path.join(homedir(), 'flow-workspace'),
    'workspace',
  )

  if (!statSync(scanPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new AiSetupError(400, `scanPath is not a folder: ${scanPath}`)
  }
  if (workspace === scanPath || workspace.startsWith(scanPath + path.sep)) {
    throw new AiSetupError(400, 'workspace must not be inside the folder being scanned')
  }
  try {
    mkdirSync(workspace, { recursive: true })
  } catch (e) {
    throw new AiSetupError(400, `cannot create workspace: ${(e as Error).message}`)
  }

  const prompt = buildAiSetupPrompt({ scanPath, workspace })
  const label = 'AI setup'
  const session = startSession({
    cwd: workspace,
    invocation: {
      command: config.claudeBin,
      // `--` ends option parsing so --add-dir (variadic) cannot swallow the prompt.
      args: [
        ...agentAutonomyArgs('claude'),
        '--strict-mcp-config',
        '--add-dir',
        scanPath,
        '--',
        prompt,
      ],
      prompts: [],
      label,
      cwd: workspace,
      env: { FLOW_URL: ctx.daemonUrl, FLOW_TOKEN: ctx.token },
    },
    kind: 'command',
  })
  return { id: session.id, label }
}
