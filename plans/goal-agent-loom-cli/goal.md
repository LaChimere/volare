# Goal State

objective: "好的，你可以调研一下，然后看看支持 bunx 这样来用 agent-loom start/config 或者其他的命令（相当于我们 agent-loom 的 cli）要怎么做。你可能需要先设计一下 agent-loom 要支持哪些命令，然后设定一个要实现的 scope 和目标，然后实现。 记得及时更新文档。"
status: active
slug: "goal-agent-loom-cli"
turns_used: 1
turn_budget: null
created_at: "2026-05-03T22:19:38.173+08:00"
updated_at: "2026-05-03T22:19:38.173+08:00"

## Acceptance criteria

- Research and record the practical constraints for publishing a Bun-native CLI through npm/bunx.
- Define an initial Agent Loom CLI command scope that is useful for local users without over-designing the full release system.
- Implement a package executable so `bunx agent-loom ...` can run CLI commands from the package shape.
- Support `agent-loom start`, `agent-loom start -d/--daemon`, and `agent-loom config codex` for the first CLI slice.
- Preserve the existing runtime behavior and server defaults unless the CLI explicitly overrides them.
- Add tests for CLI parsing/behavior where practical, and run the repository checks.
- Update related user documentation for the new CLI usage and command scope.

## Progress log

- Turn 0: Goal registered. Assumption: the first implementation slice should favor a Bun-native `bunx` package executable over a full platform-specific compiled binary release matrix.
- Turn 1: Researched Bun package executable behavior and standalone executable support, defined the MVP command scope, extracted runtime startup, added the Bun-native `agent-loom` CLI with foreground/daemon start and Codex config commands, and documented the new user-facing CLI path.

## Deferred items

- Cross-platform npm packages with precompiled standalone binaries for `npx` without Bun installed.
- Shell integration for persistent user-level API key provisioning.
- Service-manager integrations such as launchd/systemd.

## Blockers

- None.
