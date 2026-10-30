## Checks

`npm run check` runs every check this repository has: the type checks, the tests, the plugin's own tests and its validation (`package.json` defines exactly which).

## Verification

Unit tests do not show how a hook behaves inside Claude Code. When a change touches the plugin's hooks, also drive the hook script the way Claude Code does: pipe it the hook-input JSON Claude Code sends (`hook_event_name`, `tool_name`, `tool_input`, `cwd`, `session_id`) for each tool and command the change judges, in a scratch git repository set up the way the hook expects, and show the decision each one prints. Cover every outcome the ADRs define for that hook, not only the allowed path.
