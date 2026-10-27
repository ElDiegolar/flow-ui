# Flow — handoff notes for the implementing LLM

Flow is a generic fork of `horizon-ui`, a local web app that runs a long-lived
**orchestrator** coding agent (Claude Code or Codex) over a workspace of git
repos, lets it delegate to per-repo **sub-agents**, and gives the developer a
Tasks board, a Diff tab, a Commit tab, a Setup tab and per-repo **code graphs**
(graphify) the agents query instead of grepping.

The source in this repo is the horizon-ui code **copied as-is** (minus company
content). It does not run yet: it still expects a private company CLI called
`horizon` and its "helper workspace". Your job is to remove that dependency and
make the app run on any folder of git repos. This file is the complete spec.
Read it fully before touching code; every section is a unit of work with its
own acceptance check.

Conventions: TypeScript daemon (`daemon/src`, Fastify + node-pty + MCP SDK),
Vue 3 `<script setup>` web app (`web/src`, Vite), npm workspaces. No new
dependencies unless a section says so. Keep the existing comment style: each
file opens with a short "why" block. Run `npm run verify` (typecheck, lint,
prettier, build, e2e) before calling anything done.

---

## 0. Vocabulary and the one contract everything hangs off

**Workspace** — a folder the developer owns. Layout:

```
<workspace>/
  flow.config.json          # optional; see below
  projects/<category>/<repo>/   # git repos, grouped in category folders
  .agents/skills/<name>/SKILL.md   # optional shared skills (served over MCP)
  .claude/skills/<name>/SKILL.md   # optional, claude auto-loads these
  standards/<name>.md       # optional per-category standards (frontmatter below)
  AGENTS.md / CLAUDE.md     # optional workspace context for the agents
```

Repos may be real clones **or symlinks** to repos elsewhere on disk; the AI
Setup feature (§7) creates symlinks so nobody has to move code.

**flow.config.json** (all keys optional):

```json
{
  "name": "Acme workspace",
  "projectsDir": "projects",
  "categories": ["frontends", "backends"],
  "skillsDir": ".agents/skills",
  "standardsDir": "standards"
}
```

- `categories` omitted → every sub-folder of `projectsDir` that contains at
  least one git repo (a dir with `.git`, or a symlink to one).
- A repo is any direct child of a category folder that is a git repo.

**Resolution of the workspace root** (`daemon/src/common/config.ts`):
`FLOW_WORKSPACE` env → `--workspace <path>` CLI arg → walk up from cwd looking
for `flow.config.json` or a `projects/` dir → `~/flow-workspace`. If nothing
exists, the daemon still starts, reports `workspace: null` on `/api/health`,
and the Setup tab shows the AI Setup card (§7) as the first thing to do.

**Environment variables** are renamed `HORIZON_*` → `FLOW_*` throughout
(daemon, web dev proxy, e2e config, README). Mapping:

| old                                                                                       | new                         | default                       |
| ----------------------------------------------------------------------------------------- | --------------------------- | ----------------------------- |
| `HORIZON_HELPER_ROOT`                                                                     | `FLOW_WORKSPACE`            | resolution above              |
| `HORIZON_UI_HOME`                                                                         | `FLOW_HOME`                 | `~/.flow-ui`                  |
| `HORIZON_TOKEN`                                                                           | `FLOW_TOKEN`                | random, printed in the banner |
| `HORIZON_UI_URL` / `HORIZON_UI_TOKEN` (MCP env)                                           | `FLOW_URL` / `FLOW_TOKEN`   | injected                      |
| `HORIZON_AGENT_AUTONOMOUS`, `HORIZON_CLAUDE_AUTONOMY_ARGS`, `HORIZON_CODEX_AUTONOMY_ARGS` | `FLOW_…` same suffixes      | unchanged                     |
| `HORIZON_ATLASSIAN_MCP*`, `HORIZON_FIGMA_MCP*`, `HORIZON_FIGMA_ASSETS_DIR`                | `FLOW_…`                    | unchanged                     |
| `HORIZON_SKIP_INTRO`, `HORIZON_SYNC_REFRESH_MS`, `HORIZON_MCP_JIRA`, `HORIZON_MCP_FIGMA`  | `FLOW_…`                    | unchanged                     |
| `HORIZON_AUTO_PULL`                                                                       | removed (no helper to pull) | —                             |
| `HORIZON_BIN`                                                                             | removed                     | —                             |
| `CLAUDE_BIN`, `CODEX_BIN`, `GRAPHIFY_BIN`                                                 | unchanged                   | —                             |
| (new)                                                                                     | `FLOW_CODEX_HOME`           | `~/.codex`                    |

Ports: daemon `8765`, Vite `5180` (`PORT`/`DAEMON_PORT`/`WEB_PORT` as now).

**Naming**: packages `flow-ui`, `@flow-ui/daemon`, `@flow-ui/web`; UI brand
"Flow"; the MCP server is named `flow` (tools become `mcp__flow__*`; update the
pre-approved tool list in `orchestrator/brief.ts` and `orchestrator/invocation.ts`
and the codex `-c mcp_servers.flow.*` overrides). Data dir `~/.flow-ui`.

---

## 1. Daemon: replace the helper with the workspace (owner: agent A)

Files: `common/config.ts`, `common/types.ts`, `common/project.ts`,
`common/agents.ts`, `common/home.ts`, `skills.ts`, `standards.ts`,
`projectContext.ts`, `sync.ts`, `setup.ts`, `routes/setup.ts`, `main.ts`.

1. `HorizonConfig` → `FlowConfig { workspace: string | null; name: string; projectsDir: string; categories: string[] | null; skillsDir: string; standardsDir: string; claudeBin: string; codexBin: string }`. Delete `helperRoot`, `horizonBin`, `dockerCategories`, `allCategories`. Keep the type name exported as `FlowConfig` and update every import (there are ~40 `helperRoot` references; each one becomes either `config.workspace` or goes away with its feature).
2. `loadConfig()` implements the resolution in §0 and parses `flow.config.json` (ignore unknown keys, validate types, never throw on a missing file). Add `reloadConfig()` so §7 can re-resolve after the AI setup writes files; `RouteContext.config` must be read through a getter or a mutable holder so routes see the reload.
3. `listProjects()` discovers categories/repos per §0. `ProjectCategory.hasDocker` is removed. `resolveRepoPath()` → `<workspace>/<projectsDir>/<category>/<repo>` (category matched case-insensitively against discovered names, since URLs lower-case it).
4. `codexHome()` → `FLOW_CODEX_HOME ?? ~/.codex`. `resolveCodex()` drops the helper-local npm path.
5. `skills.ts`: sources become `<workspace>/<skillsDir>` (delivery `harness`) and `<workspace>/.claude/skills` (delivery `auto`). Delete the `CATEGORY_SKILLS` name map (it listed company skill names); a skill applies to a category when its frontmatter has `categories: [..]` or its name starts with the category name. `standards.ts`: read `<workspace>/<standardsDir>/*.md`; a file applies to a category when its frontmatter `applies:` lists it (keep the current frontmatter parser; just change the directory and remove the bundled `daemon/standards` dir from the lookup).
6. `projectContext.ts`: "root" is the workspace; context files are `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` at the workspace root and in the repo, same rules as now.
7. `sync.ts`: delete `pullHelper` and everything about the helper being behind; keep the per-repo fetch + behind/dirty report (it is plain git and drives the repo badges). Rename the banner wording in the web accordingly (§3).
8. `setup.ts`: keep the `claude` and `codex` checks, the Atlassian and Figma MCP checks, and add a `workspace` check (group `host`, required): ready when `config.workspace` exists and has ≥1 repo, otherwise `missing` with detail "No workspace found. Use AI Setup below or set FLOW_WORKSPACE." Delete the WSL networking check and `wsl.ts` + the `apply-wsl-networking` route and its UI. Delete `codexHome`-based detection of the helper's npm codex.
9. `main.ts` banner: print the workspace path (or "none — open Setup") instead of the helper root.

Acceptance: `npm run typecheck` passes with **zero** references to `helperRoot`,
`horizonBin`, `.interface`, `HORIZON_`. Starting the daemon with
`FLOW_WORKSPACE=web/tests/e2e/fixtures/workspace` lists the fixture repos on
`/api/projects`.

## 2. Daemon: remove helper-driven commands, launch agents directly (owner: agent A)

Files: `sessions.ts`, `functions/*`, `routes/sessions.ts`, `routes/projects.ts`,
`mcp/horizonMcp.ts` → rename to `mcp/flowMcp.ts`, `orchestrator/*`, `park.ts`,
`pty.ts`.

1. Delete `functions/project/*`, `functions/docker/*`, `functions/aws/*`,
   `functions/host/*`. Delete `routes/visual.ts`, `visual.ts`, `VISUAL_DIR`,
   and the `visual_*` MCP tools and `/api/visual/*` routes. Delete
   `list_containers`, `project_launch`, `project_open`, `docker_create`,
   `docker_destroy` MCP tools. `CommandKind` becomes
   `'agent' | 'agent-codex' | 'agent-claude' | 'git-commit' | 'ai-setup'`.
2. `functions/agent/index.ts`: the claude path no longer goes through
   `horizon agent claude`. Spawn `config.claudeBin` directly with
   `cwd = repo path`, args `[...agentAutonomyArgs('claude'), '--strict-mcp-config', '--add-dir', <workspace>, prompt]`.
   Keep the codex path (it is already direct). Keep standards + code-graph
   prompt assembly exactly as is.
3. `functions/git/commit.ts`: replace the helper-driven commit with plain git
   run in the repo: `git add -A && git commit -m <message>`; the message comes
   from the Commit tab (§3). Keep the destructive-action confirmation path the
   orchestrator's `git_commit` tool uses. No agent is involved in committing.
4. `pty.ts`/`Invocation`: `command` becomes required (there is no default
   binary any more); `prompts` (fzf automation) can stay, unused by the two
   remaining invocations, or be removed if nothing references it.
5. `orchestrator/invocation.ts` + `orchestrator/index.ts`: MCP server renamed
   `flow`; the `--mcp-config` JSON key and the codex overrides follow. The
   orchestrator's cwd is the workspace root.
6. `orchestrator/brief.ts`: rewrite the brief for Flow. Remove every mention of
   horizon, the helper, docker, containers, Visual Q&A, `project_launch`.
   Keep: delegate-everything rule, driving sub-agents, skills over MCP, board,
   destructive confirmations, learnings, branches, CODE GRAPH section, Jira
   and Figma sections (conditional on settings), workspace list, models,
   pinned project section. Add one line: "The workspace is `<name>` at
   `<path>`; repos are `projects/<category>/<repo>`."
7. `park.ts`: parked tasks referenced helper paths only via `config`; follow the
   type change.
8. `sessions.ts`: the `project-clone` → code-graph hook goes away with clone.
   Keep the `agent*` and `git-commit` cases; add `ai-setup` (§7).

Acceptance: the orchestrator starts from the UI against the fixture workspace
with the fake claude (`web/tests/e2e/fixtures/fake-claude.mjs`), `run_agent`
spawns a sub-agent whose cwd is the repo, `git_commit` commits in the repo.
The e2e specs `orchestrator-flow`, `orchestrator`, `terminal-paste` pass
(`visual-task.spec.js` is deleted with the feature).

## 3. Web: trim tabs, rebrand, generic copy (owner: agent B)

Files: `web/src/App.vue`, `views/*`, `components/*`, `store.js`, `api.js`,
`style.css`, `theme-cyberpunk.css`, `index.html`.

1. Tabs: `Tasks, Orchestrator, Agent, Commit, Diff, Setup`. Delete
   `Dashboard.vue`, `VisualView.vue`, `ProjectCard.vue`, the `visual` api
   group, `store.visualVersion`, the Dashboard/Visual entries in `settings.tabs`
   (daemon side too: `TabSettings` becomes `{ agent, commit, diff }`; the
   Sections card in Setup follows). Keep `CommandRunner.vue` + `TerminalPanel.vue`
   (Agent, Commit and AI Setup stream into them).
2. Brand: "Horizon Flow" → "Flow" (header, `<title>`, intro, favicon text if
   any). Header pills: context, workspace name (replaces the helper-path pill,
   `title` = full path), docker pill removed, jira/figma pills stay.
3. Copy pass: every string that says helper, horizon, Bitbucket, container,
   docker, WSL, Visual Q&A or names a company project goes. `grep -rniE
"horizon|helper|bitbucket|docker|wsl|visual" web/src` must come back with
   only the `flow` MCP name and the Figma/Jira integration text.
4. Commit tab: a repo picker (category/repo), the `git status` summary it
   already shows, a message textarea, and a Commit button → `POST /api/sessions`
   `{ command: 'git-commit', category, repo, message }`. Remove the agent
   picker it had (the helper used an agent to write messages).
5. Desync banner: only the per-repo "behind origin" form remains; delete the
   helper-behind variant and its "Check now" wording about the helper.
6. Setup page: keep the §(Sections, Coding agents, MCP servers, Models,
   Behaviour, Wiring) cards; the Host card becomes "Workspace" (the new
   `workspace` check + the AI Setup card from §7). Delete the WSL InfoTip and
   Apply button. Wiring shows workspace path, MCP config path, MCP servers.
7. First-run intro (`SetupIntro.vue`): step 1 becomes "Point Flow at your code"
   with the AI Setup button; steps 2–3 stay Jira / Figma, both skippable.

Acceptance: `npm run build -w web` clean; `npx eslint web/src` clean; the grep
in item 3 is clean; screenshots of Tasks, Orchestrator, Setup at 1280 and 390
show no clipped header and no empty cards.

## 4. e2e + fixtures (owner: agent B, after §3)

1. Replace `web/tests/e2e/fixtures/helper-root/` with
   `web/tests/e2e/fixtures/workspace/` containing `flow.config.json`
   (`{"name":"Fixture"}`) and `projects/demo/alpha/` initialised as a tiny git
   repo by the playwright `webServer` command (`git init` + one commit; the
   repo dir itself is gitignored, only a `seed.sh` is committed).
2. `playwright.config.js`: env renamed per §0; `FLOW_WORKSPACE` points at the
   fixture; remove `HORIZON_AUTO_PULL`.
3. Update the three remaining specs for the new tab list and brand; delete
   `visual-task.spec.js`. Add `setup.spec.js`: Setup renders the Workspace
   card as ready against the fixture, and toggling Diff off removes the tab.

Acceptance: `npm run test:e2e -w web` green.

## 5. Code graphs (no owner — already generic)

`daemon/src/codeGraph.ts` and `routes/codeGraph.ts` only need the type rename
(`FlowConfig`) and `homePath` → `~/.flow-ui/graphs`. The graphify install hint
stays. Nothing else changes.

## 6. Docs (owner: agent C)

1. `README.md` for a developer at another company: what Flow is in five
   lines, prerequisites (Node 22, Claude Code and/or Codex logged in,
   optional `uv tool install graphifyy`), `npm install && npm run dev`, open
   the banner URL, Setup → AI Setup, then the tab tour (Tasks, Orchestrator,
   Agent, Commit, Diff, Setup). A section "Workspace layout" copying §0. A
   section "Environment" with the `FLOW_*` table. A section "Running two
   copies". No mention of horizon, the helper, or any company.
2. `docs/ARCHITECTURE.md`: one page: daemon (Fastify, PTY sessions, MCP server
   the orchestrator talks back to, integrations hub, code graphs), web
   (single events socket, store, tabs), the security model (loopback only,
   one-time token, agents run with bypassed permissions **inside the
   workspace only**, destructive tools confirmed by the human).
3. Keep this file (`docs/HANDOFF.md`) and append a "Status" section listing
   what each agent completed and what is left.

## 7. AI Setup (owner: agent C, daemon + web)

Goal: a button that has an agent configure the workspace for the developer so
they do not read any of §0.

Daemon:

1. `POST /api/setup/ai` body `{ scanPath: string, workspace?: string }`.
   `scanPath` is a folder on this machine that contains their repos (any
   depth ≤ 3). `workspace` defaults to `config.workspace ?? ~/flow-workspace`.
   Validates both are absolute; creates the workspace dir if missing.
2. Spawns a **claude** session (`startSession`, kind `command`, label
   `AI setup`) with cwd = workspace, `config.claudeBin`, args
   `[...agentAutonomyArgs('claude'), '--strict-mcp-config', '--add-dir', scanPath, prompt]`
   and env `FLOW_URL`, `FLOW_TOKEN` (so it can call the daemon's API with
   curl). Returns `{ id, label }` like other spawns, so the web streams it in
   a terminal pane.
3. The prompt (put it in `daemon/src/aiSetup.ts` as a template) tells the
   agent, in this order, to:
   - List git repos under `scanPath` (depth ≤ 3, skip node_modules/vendor).
   - Group them into 2–6 categories by what they are (frontend, backend,
     service, library, infra, docs…), using folder names, package manifests
     and READMEs. Prefer the developer's own folder structure when it already
     groups things.
   - Create `<workspace>/projects/<category>/<repo>` as **symlinks** to the
     originals (never move or copy code). Write `flow.config.json` with
     `name` = the scan folder's name.
   - Write `<workspace>/AGENTS.md` (and a `CLAUDE.md` that includes it):
     one paragraph per category on what lives there, how to run tests and the
     dev server if the repo says so, and the branch naming it observes. Keep it
     under 150 lines; cite files, do not invent.
   - For each category write `<workspace>/standards/<category>.md` with
     frontmatter `applies: [<category>]` and five to ten bullet rules it can
     **see** in the code (linters, formatters, test layout, commit style).
     Skip a category where nothing is evident.
   - Call `POST $FLOW_URL/api/config/reload` (header `X-Flow-Token`) then
     `POST $FLOW_URL/api/code-graph/build {"all":true}` and report the result.
   - Finish with a short summary of what it created and anything it was
     unsure about. It must not touch files outside `<workspace>` and must
     not run package managers or builds.
4. `POST /api/config/reload` → `reloadConfig()`, re-publishes `context` and a
   `projects-changed` bus event; the web reloads the project list on it.
5. Setup check `workspace` detail links to this flow when missing.

Web: 6. Setup → Workspace card: path input (default `~/code`), "AI Setup" primary
button (disabled with a reason when the `claude` check is not ready), a
note "Creates symlinks under <workspace>/projects, writes AGENTS.md and
standards, builds code graphs. Nothing in your repos is modified." The
session streams in a `CommandRunner` below the card; on exit the card
re-runs the setup checks and shows the discovered categories/repos. 7. The same button in the first-run intro (§3.7).

Acceptance: against a scratch folder with three small git repos and the real
`claude`, pressing AI Setup produces the symlinks, `flow.config.json`,
`AGENTS.md`, ≥1 standards file, and `/api/projects` lists them without a
daemon restart. With the fake claude in e2e, the route spawns and the pane
shows output (fake claude prints its prompt).

---

## 8. Order of work and ownership

Three agents can work in parallel from the start if they stay in their files:

- **A — daemon core** (§1, §2, §5). Largest. Start with `types.ts`/`config.ts`,
  then follow the compiler.
- **B — web** (§3, §4). Can start immediately against the contract in §0 and
  the API shapes that do not change (`/api/projects` still returns
  `{ name, slug, repos }` per category; `/api/sessions` body as in §2/§7).
- **C — docs + AI Setup** (§6, §7). Writes `aiSetup.ts`, `routes/aiSetup.ts`
  (registered in `main.ts`), and the Setup-card UI in
  `web/src/components/AiSetupCard.vue` which B mounts. C must not edit
  `config.ts`; it calls `reloadConfig()` which A provides (agree the name now:
  `export function reloadConfig(): FlowConfig` in `common/config.ts`, and
  `getConfig(): FlowConfig` for the current one).

Merge order: A, then B, then C. After all three, one pass over `grep -rniE
"horizon|helper" --exclude-dir=node_modules .` and `npm run verify`.

## 9. Things that are easy to get wrong

- `claude --add-dir` must be given the **workspace** (so shared skills and
  AGENTS.md are readable) and the sub-agent's cwd must be the **repo**, not
  the workspace, or every sub-agent edits the wrong tree.
- `--strict-mcp-config` with no `--mcp-config` means "no MCP servers": keep it
  on sub-agents, or they inherit the developer's user-scope servers and open
  login windows.
- Category names are matched case-insensitively from URLs; keep the discovered
  casing for display.
- Symlinked repos: use `fs.statSync` (follows links), not `lstatSync`, when
  deciding whether a dir is a repo; `git -C <symlink>` works fine.
- The events socket is the only live channel; new server-side state (reload,
  projects changed) must be published on the bus or the UI will not notice.
- Do not keep any file from `daemon/learnings`, `daemon/standards` or
  `web/tests/visual` of the original: they contained company knowledge and
  screenshots. The directories exist here with only a `.gitkeep`.

---

## Status — agent C

Done:

- §7 daemon: `daemon/src/aiSetup.ts` (prompt template, `startAiSetup`), `daemon/src/routes/aiSetup.ts` (`POST /api/setup/ai`, `POST /api/config/reload`), registered in `main.ts`.
- §7 web: `web/src/components/AiSetupCard.vue` (props `ready`, `reason`; emits `session-start` and `session-done`), `api.setup.ai()` and `api.config.reload()` in `api.js`.
- §6: `README.md` rewritten; `docs/ARCHITECTURE.md` added with Mermaid and SVG; `docs/architecture.svg` added.
- Prettier and ESLint clean on my files.

Needs from others:

- A: `bus.ts` needs `{ type: 'projects-changed'; reason: string }` in `AppEvent`.
- A: `setup.ts` workspace check detail should link to AI Setup when missing.
- A: `reloadConfig()` must update what `RouteContext.config` reads (route uses `getConfig()` at request time).
- B: mount `AiSetupCard` in Setup → Workspace and the intro, and pass `session-start` to `CommandRunner`.
- Not verified end to end: the real `claude` run and the e2e fake-claude spawn.

## Status — agent B (web §3 + §4)

Done in `web/` only (no daemon edits, nothing committed):

- Tabs: Tasks, Orchestrator, Agent, Commit, Diff, Setup. Dashboard, Visual and
  `visual` api group, `ProjectCard`, `DangerConfirm`, WSL Apply removed.
- Brand "Flow" in header, `<title>`, intro, notifications; header pills show
  workspace name (title = path); docker pill removed.
- Commit tab: project/repo picker, git status summary, message box, POSTs
  `{ command: 'git-commit', category, repo, message }`; agent picker removed.
- Repos-behind-origin banner (per repo names); helper variant removed.
- Setup: Workspace card (AiSetupCard mounted, WSL removed), Wiring shows
  workspace path. First-run intro step 1 "Point Flow at your code" (AI Setup).
- e2e: `fixtures/helper-root` replaced by `fixtures/workspace` (flow.config.json,
  seed.sh; `projects/` gitignored); playwright env renamed to FLOW\_\*; new
  `setup.spec.js`; `visual-task.spec.js` deleted; `docker_destroy` tool renamed
  `git_commit` in fake-claude and the orchestrator spec.
- Needs from A: auth header is now `X-Flow-Token` (web and specs send it);
  `/api/health` workspace fields; `/api/setup` should include `workspace` (Wiring).

Left: run `npm run test:e2e -w web` after merge; daemon-side `visual`/`docker`
routes must be gone for the header/tab contract to hold.

---

## Status — agent A (daemon §0, §1, §2, §5)

Done: `common/config.ts` resolves the workspace (FLOW*WORKSPACE, --workspace,
walk-up, ~/flow-workspace) and exposes `getConfig()` / `reloadConfig()`;
`RouteContext.config` is a getter over it. Helper-driven commands removed; the
agent runs `config.claudeBin` directly; `git-commit` is `sh -c "git add -A && git
commit -m"` in the repo. MCP server is `flow` (`mcp/flowMcp.ts`), with the
visual, docker, container and project-launch tools removed. Standards and skills
read from the workspace. `/api/setup` has a `workspace` check. Env vars are
renamed `FLOW*\*`. Code graphs kept.

Not done here: the e2e fixtures and web are agent B's; the README and
ARCHITECTURE are agent C's.

---

## 10. Commands layer (implemented)

The generic replacement for a company's command set: a team declares its own
scripts and CLI in `flow.config.json`, and both the developer (UI) and the
orchestrator (MCP) can run them. Flow does not interpret them. Worked example:
`examples/` (config, a stand-in CLI, and its README).

**Config** (`common/config.ts`, type `FlowCommand` in `common/types.ts`). Optional
`commands` array; `FlowConfig.commands` defaults to `[]`.

```json
{ "id": "test", "label": "Run tests", "run": "npm test", "scope": "repo" }
```

- `id` must match `^[a-z0-9-]+$`; `label` and `run` are non-empty strings.
- `scope`: `"repo"` (default) or `"workspace"`.
- `categories`: optional filter, repo scope only (case-insensitive match).
- `confirm`: optional boolean. `true` = destructive.
- An invalid entry, or a duplicate id, is skipped with one `console.warn`.

**Execution** (`commands.ts`). `run` is executed with `sh -c` (not `bash -lc`, so
no login profile is sourced). cwd = repo path for `repo` scope, workspace root
for `workspace`. Env added to the PTY: `FLOW_WORKSPACE` (always), `FLOW_CATEGORY`,
`FLOW_REPO`, `FLOW_REPO_PATH` (empty strings for workspace scope).

- `listCommands(config, category?, repo?)`: workspace commands always; repo
  commands only when both category and repo are given and the category passes
  the filter. With neither, only workspace commands.
- `buildCommandInvocation(config, id, category?, repo?)` → `Invocation`
  `{ command: 'sh', args: ['-c', run], cwd, env, prompts: [], label }`, where
  label is `<label> — <category>/<repo>` (or `<label> — workspace`). Throws
  `CommandError` (400, or 409 with no workspace).

**HTTP.**

- `GET /api/commands?category&repo` → `{ commands: [{ id, label, scope, confirm }] }`
  (`routes/commands.ts`).
- `POST /api/sessions` with `{ command: 'run', id, category?, repo?, confirmed? }`
  (`sessions.ts`) starts a PTY session of kind `command`, the same way `git-commit`
  does. 400 for: no `id`, unknown `id`, a repo command without category/repo, a
  category outside its filter, a missing repo, or a `confirm` command without
  `confirmed: true`.

**Orchestrator** (`mcp/flowMcp.ts`, `orchestrator/brief.ts`).

- `list_commands { category?, repo? }` → `GET /api/commands`.
- `run_command { id, category?, repo?, confirmed? }` → `POST /api/sessions` with
  command `run`.
- Both are on `ORCHESTRATOR_SAFE_TOOLS`. The brief has a COMMANDS paragraph: run
  configured commands with `run_command`, and a `confirm` command needs the
  human's OK first.
- Limitation: Claude Code's `--allowedTools` matches tool names only, not
  arguments. So `confirmed: true` is enforced by the orchestrator following the
  brief, not by a permission prompt. The daemon enforces the flag's presence
  only. A stricter setup would take `run_command` off the allowlist and accept a
  prompt on every run.

**Web.** `api.commands.list(category, repo)`; `components/CommandsPanel.vue`
(props `category`, `repo`; buttons; `window.confirm` for `confirm` commands, then
sends `confirmed: true`; emits `session-start` `{ id, label }`). Mounted in
`views/AgentView.vue` under the repo picker, so the existing `CommandRunner` streams
the output.


> Decision (coordinator): `run_command` is deliberately **not** in the orchestrator's pre-approved tool list, so Claude Code prompts the human for every run, exactly like `git_commit`. The daemon's `confirmed: true` check stays as a second guard for `confirm` commands.
