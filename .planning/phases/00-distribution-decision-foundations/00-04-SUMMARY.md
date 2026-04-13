# Phase 0 Task 4 Summary: Config Library + Secrets Encryption

## Schema Fields

### Top-level (`configSchema`)
- `version: z.literal(1)` — locked at v1
- `learner` — model, maxCapturesPerRun, timeoutSeconds (all with defaults)
- `scrubber` — entropyThreshold (default 4.5), minTokenLen (default 20), rulePackPath (optional)
- `license` — **RESERVED for Phase 6** (see below)

### License Namespace (reserved, all optional)
- `keyRef: string` — pointer into secrets.enc (NOT the key itself)
- `trialStartedAt: number` — unix timestamp
- `lastValidated: number` — unix timestamp
- `offlineGraceDays: number` — positive integer

All schemas use `.strict()` at every nesting level. Unknown keys produce `ConfigError` with `.file` and `.unknownKeys`.

## Secrets File Format (`secrets.enc`)
```json
{
  "v": 1,
  "salt": "<hex, 16 bytes>",
  "iv": "<hex, 12 bytes>",
  "tag": "<hex, 16 bytes>",
  "ciphertext": "<base64>"
}
```
- **KDF**: scryptSync (N=16384, r=8, p=1) with machine-id as password
- **Cipher**: aes-256-gcm (AEAD)
- **IV**: 12-byte random per encryption
- **Salt**: 16-byte random per encryption
- File written atomically (tmp + rename), mode 0600

## Machine-ID Fallback Chain
1. `node-machine-id` (dynamic import, SHA-256 hashed)
2. Fallback: `sha256(hostname + uid + salt)` — deterministic, never throws

## Test Count
- **27 tests** across 5 test files (schema: 6, merge: 4, loader: 6, machine-id: 3, secrets: 8)
- All run under no-network harness
- Zero network egress confirmed
- Round-trip encryption verified
- GCM tamper detection verified
