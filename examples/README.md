# Commands: plug your own scripts or CLI into Flow

Flow can run a team's own scripts (tests, builds, deploys, an internal CLI) from
buttons in the UI and as tools for the orchestrator. Nothing here is built in:
you declare each command in `flow.config.json` and Flow runs the string you give
it.

## Declaring a command

Add a `commands` array to `<workspace>/flow.config.json`. The file in this
folder, `flow.config.example.json`, is a complete example.

| field        | required | meaning                                                                                                                  |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`         | yes      | Unique, `^[a-z0-9-]+$`. The name the orchestrator and the API use.                                                       |
| `label`      | yes      | Button text and session title.                                                                                           |
| `run`        | yes      | Shell string, executed with `sh -c`. Pipes, `&&` and relative paths work.                                                |
| `scope`      | no       | `"repo"` (default) runs in the repo; `"workspace"` runs in the workspace root.                                           |
| `categories` | no       | Repo scope only. The categories it applies to; omitted = every category.                                                 |
| `confirm`    | no       | `true` marks it destructive: the UI asks first, and the orchestrator must get the human's OK and send `confirmed: true`. |

An invalid entry is skipped and the daemon logs one warning naming the reason;
the others still load. A duplicate `id` keeps the first entry.

## What a command receives

Flow starts `sh -c <run>` in a terminal session with the environment of the
daemon plus:

| variable         | repo scope                     | workspace scope |
| ---------------- | ------------------------------ | --------------- |
| `FLOW_WORKSPACE` | the workspace root             | the same        |
| `FLOW_CATEGORY`  | the category, e.g. `frontends` | empty           |
| `FLOW_REPO`      | the repo name, e.g. `web-app`  | empty           |
| `FLOW_REPO_PATH` | absolute path of the repo      | empty           |

The working directory is the repo path for `repo` scope and the workspace root
for `workspace` scope.

## Wiring in an internal CLI

Keep the CLI in the workspace (for example `<workspace>/tools/acme`) and point
`run` at it. `acme-cli/acme` is a stand-in that only echoes what it would do:

```bash
cp examples/acme-cli/acme <workspace>/tools/acme && chmod +x <workspace>/tools/acme
```

Then the config entry `"run": "./tools/acme deploy staging"` (workspace scope,
`confirm: true`) gives a Deploy staging button. A repo-scope entry such as
`"run": "./tools/acme status"` needs no arguments, because the script reads
`FLOW_REPO_PATH` from its environment.

## How the orchestrator uses them

- `list_commands { category?, repo? }` returns the commands it may run. With a
  repo, that repo's commands are included; with neither, only workspace commands.
- `run_command { id, category?, repo?, confirmed? }` starts one and returns a
  session id. Follow it with `wait_for_session`, as with any sub-agent.
- A command with `confirm: true` is refused by the daemon unless `confirmed` is
  `true`. The orchestrator's brief tells it to send that only after the human
  agrees.

The same commands are available to the developer from the Agent tab, under the
repo picker, which streams the output in the terminal below.

## HTTP

```
GET  /api/commands?category=frontends&repo=web-app
  -> { "commands": [ { "id", "label", "scope", "confirm" } ] }

POST /api/sessions  { "command": "run", "id": "test", "category": "frontends", "repo": "web-app" }
  -> { "id": "<session id>", "label": "Run tests — frontends/web-app" }
  400 unknown id, a repo command without category/repo, or a confirm command without confirmed:true
```
