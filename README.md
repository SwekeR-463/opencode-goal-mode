# opencode-goal-mode

Persistent goal mode for [OpenCode](https://opencode.ai): set a goal for a session and the agent keeps working across turns, auto-continuing when it goes idle, until the goal is complete or genuinely blocked.

## Usage

- `/goal <objective>` — start a goal. It becomes a standing instruction on every model request in that session.
- `/goal status` — report the saved goal without working on it.
- `/goal pause` / `/goal resume` — stop and restart automatic continuation.
- `/goal clear` — forget the goal.
- `/goal set <objective>` — only needed when the objective starts with a reserved word (`status`, `pause`, `resume`, `clear`, `set`).

The agent signals completion by ending its final response with `<goal-complete>` on its own line, or with `<goal-blocked>` when genuinely stuck. When a turn ends without either marker, the plugin queues one continuation prompt. Each goal allows at most 12 auto-continuations; on the cap, or on a provider error, the goal stops itself instead of looping forever.

Goal state is stored per session with the plugin storage API, so it survives restarts.

## Install

Requires OpenCode v2 with a compatible `@opencode/plugin`. Built and tested against OpenCode 2.0.27 / `@opencode/plugin@2.0.27`.

From a checkout (no build step — OpenCode loads TypeScript directly):

```jsonc
// opencode.jsonc
{
  "plugins": ["/absolute/path/to/opencode-goal-mode"]
}
```

Or copy `src/index.ts` into `~/.config/opencode/plugins/` (any discovered plugins directory works).

From npm, once published:

```sh
opencode plugin add opencode-goal-mode
```

## Development

```sh
npm install
npm run check   # typecheck + tests
```

## License

MIT
