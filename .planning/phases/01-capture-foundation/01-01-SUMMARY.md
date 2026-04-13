# 01-01 Summary: Types, Schemas, Kill-switch, Paths

## Exported Symbols

### `src/capture/events.ts`
| Export | Kind | Consumed by |
|--------|------|-------------|
| `UserPromptSubmit` | Zod schema | 01-03 writer, 01-02 shim |
| `PreToolUse` | Zod schema | 01-04 tool-calls |
| `PostToolUse` | Zod schema | 01-04 tool-calls |
| `Stop` | Zod schema | 01-03 writer |
| `SubagentStop` | Zod schema | 01-07 subagent |
| `HookPayload` | Zod discriminatedUnion | 01-03 writer (main parse entry) |
| `*Payload` types | TS inferred types | All downstream plans |

### `src/capture/types.ts`
| Export | Kind | Consumed by |
|--------|------|-------------|
| `TurnMeta` | Interface (C3 schema) | 01-03 writer (meta.json), 01-06 global mirror |
| `TURN_META_SCHEMA_VERSION` | Const `1` | 01-03 writer |
| `ToolCallLine` | Union type (pre\|post) | 01-04 tool-calls |
| `ToolCallLinePre` | Interface | 01-04 tool-calls |
| `ToolCallLinePost` | Interface | 01-04 tool-calls |

### `src/capture/kill-switch.ts`
| Export | Kind | Consumed by |
|--------|------|-------------|
| `isCaptureDisabled` | Function | 01-02 shim, 01-03 writer |

### `src/capture/paths.ts`
| Export | Kind | Consumed by |
|--------|------|-------------|
| `CapturePaths` | Interface | 01-03 writer, 01-05 disk-budget, 01-06 global mirror |
| `getCapturePaths` | Function | 01-03 writer (main path builder) |
| `detectDevArmyAgent` | Function | 01-06 global mirror (namespace routing) |

## Test Coverage
- 26 tests across 3 test files, all passing
- Full test suite (151 tests) green
- Typecheck clean, lint clean

## Design Decisions
- `getCapturePaths` takes `projectId` as parameter (not calling PathResolver internally) to keep it synchronous and free of Phase 0 runtime coupling. Caller (writer) resolves identity once via PathResolver and passes the hash.
- All schemas use `.passthrough()` to tolerate future Claude Code fields without breaking.
- `isCaptureDisabled` accepts injectable env for testability without process.env mutation.
- `detectDevArmyAgent` uses strict prefix + separator check to avoid false matches on similar paths.
