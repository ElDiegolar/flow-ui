# Flow

Flow is a local web app for working on many git repositories with coding agents.
You keep your repos where they are. Flow links them into one workspace folder,
runs an orchestrator agent (Claude Code or Codex) that plans the work and hands
each repo to its own sub-agent, and shows you the board, the agents' terminals,
the diffs and the commits in one page. Everything runs on your machine, on
loopback, under a token. Nothing is sent to a Flow server, because there is none.

![Flow architecture](docs/architecture.svg)

## Prerequisites

- Node.js 22
- Claude Code, logged in (`claude`), and/or Codex, logged in (`codex`)
- Optional: graphify for per-repo code graphs: `uv tool install graphifyy`
- Optional: a Jira board and Figma Desktop, for the Tasks board and design context

## Quick start

```sh
npm install
npm run dev
```

The daemon prints a banner with an **Open** link that includes a one-time token.
Open it. On first run, go to **Setup → Workspace**, enter the folder that holds
your repos (default `~/code`), and press **AI Setup**. Claude asks you to trust the new workspace folder the first time; answer in the pane. The session then scans
that folder, links the repos into a workspace, writes the workspace notes and
standards, and builds the code graphs. You do not have to create any layout by
hand. When it finishes, the categories and repos appear in the app.

Then take the tour:

- **Tasks**: a board. Add a task, or sync it from Jira, and start it. The
  orchestrator gets the task and the repo it belongs to.
- **Orchestrator**: the long-lived agent that plans the work, starts sub-agents
  in repos, and reports back. You can talk to it here.
- **Agent**: start a coding sub-agent in one repo directly, without the
  orchestrator.
- **Commit**: pick a repo, read its status, write a message, commit.
- **Diff**: what the agents changed, per repo, before you commit.
- **Setup**: checks for the agents, the workspace and the integrations; model
  profiles; which tabs show; the AI Setup button.

## Workspace layout

A workspace is one folder you own:

```
<workspace>/
  flow.config.json              # optional: name, projectsDir, categories, skillsDir, standardsDir
  projects/<category>/<repo>/   # git repos, grouped in category folders (symlinks are fine)
  .agents/skills/<name>/SKILL.md  # optional shared skills, served to agents over MCP
  .claude/skills/<name>/SKILL.md  # optional, loaded by Claude Code automatically
  standards/<name>.md           # optional rules per category (frontmatter: applies: [...])
  AGENTS.md / CLAUDE.md         # optional context for the agents
```

- Without `categories` in `flow.config.json`, every folder under `projects/`
  that holds at least one git repo is a category.
- A repo is any direct child of a category folder that is a git repo.
- Repos can be real clones or symlinks to repos elsewhere on disk. Flow never
  moves or copies your code.

Flow finds the workspace from, in order: `FLOW_WORKSPACE`, a `--workspace`
argument, the nearest folder above the current directory with a
`flow.config.json` or `projects/`, and finally `~/flow-workspace`. If none
exists, Flow still starts and Setup asks you to run AI Setup.

## Environment

| Variable                                       | Default                                              | Purpose                                                            |
| ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| `FLOW_WORKSPACE`                               | see above                                            | Workspace folder                                                   |
| `FLOW_HOME`                                    | `~/.flow-ui`                                         | Settings, tasks, learnings, graphs                                 |
| `FLOW_TOKEN`                                   | random, printed in the banner                        | Token for the API and the page                                     |
| `FLOW_CODEX_HOME`                              | `~/.codex`                                           | Codex home directory                                               |
| `CLAUDE_BIN`                                   | `claude` on PATH                                     | Claude Code executable                                             |
| `CODEX_BIN`                                    | `codex` on PATH                                      | Codex executable                                                   |
| `GRAPHIFY_BIN`                                 | `graphify` on PATH                                   | graphify executable                                                |
| `FLOW_AGENT_AUTONOMOUS`                        | on                                                   | Set to `0` to make agents ask before each action                   |
| `FLOW_CLAUDE_AUTONOMY_ARGS`                    | `--permission-mode bypassPermissions`                | Claude flags for unattended runs                                   |
| `FLOW_CODEX_AUTONOMY_ARGS`                     | `--ask-for-approval never --sandbox workspace-write` | Codex flags for unattended runs                                    |
| `FLOW_ATLASSIAN_MCP`, `FLOW_ATLASSIAN_MCP_URL` | on, `https://mcp.atlassian.com/v1/mcp`               | Set `FLOW_ATLASSIAN_MCP=0` to turn off the Jira (Atlassian) server |
| `FLOW_FIGMA_MCP`, `FLOW_FIGMA_MCP_URL`         | on                                                   | Set `FLOW_FIGMA_MCP=0` to turn off the Figma server                |
| `FLOW_FIGMA_ASSETS_DIR`                        | off                                                  | Folder where Figma assets are saved                                |
| `FLOW_SYNC_REFRESH_MS`                         | 600000                                               | How often repos are fetched; `0` disables                          |
| `FLOW_CONTEXT_POLL_MS`                         | 2000                                                 | How often the active branch is re-read                             |
| `FLOW_SKIP_INTRO`                              | off                                                  | Set to `1` to skip the first-run walkthrough                       |
| `HOST`                                         | `127.0.0.1`                                          | Daemon address. Keep it on loopback                                |
| `PORT`                                         | `8765`                                               | Daemon port                                                        |
| `WEB_PORT`                                     | `5180`                                               | Web (Vite) port                                                    |
| `DAEMON_PORT`, `DAEMON_URL`                    | `8765`                                               | Where the web dev server proxies `/api`                            |

`FLOW_URL` and `FLOW_TOKEN` are set for agents by Flow itself; you do not set them.

## Running two copies

To run a second instance next to the first, give it its own ports and home:

```sh
PORT=8766 DAEMON_PORT=8766 WEB_PORT=5181 FLOW_HOME=$HOME/.flow-ui-2 npm run dev
```

## Commands: plug in your own scripts or CLI

Declare a `commands` array in `flow.config.json` and each entry becomes a button
in the Agent tab, and a tool (`list_commands`, `run_command`) the orchestrator can
use for tests, builds or deploys. Each runs as `sh -c <run>` in the repo or the
workspace root, with `FLOW_WORKSPACE`, `FLOW_CATEGORY`, `FLOW_REPO` and
`FLOW_REPO_PATH` set. Entries marked `"confirm": true` ask first. See
[`examples/`](examples/README.md) for the format and a stand-in internal CLI.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the daemon, the web app,
the security model and the files Flow writes.

## Development

```sh
npm run typecheck     # daemon types
npm run lint          # ESLint
npm run format:check  # Prettier
npm run build         # web build
npm run test:e2e      # Playwright end-to-end tests
npm run verify        # all of the above
```
