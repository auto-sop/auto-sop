# PLAN-v40: BIND-8 CLI Request Encryption (X25519)

## Overview
Complete BIND-8 by adding client-side request encryption to the CLI. Server-side decryption is already live (v39). The X25519 public key is already embedded in `server-public-key.ts`. This plan wires the encryption into the validate request path so license keys and machine IDs are encrypted at the application layer (defense-in-depth over HTTPS).

## Project
**auto-sop** (CLI repo)

## Architecture Decisions
- X25519 ECDH key agreement: CLI generates ephemeral keypair per request, derives shared secret with server's static public key, encrypts with AES-256-GCM.
- Server expects `Content-Type: application/x-asop-encrypted` with body: `{ ephemeral_public: hex, nonce: hex, ciphertext: hex }`.
- HKDF-SHA256 derives AES key from raw ECDH shared secret (matches server's `src/lib/x25519.ts` implementation).
- Fallback: if encryption fails (e.g., crypto API unavailable on old Node), send unencrypted request with `Content-Type: application/json`. Server accepts both while `BIND8_REQUIRE=false`.
- No new dependencies — Node.js `crypto` module only.
- The existing `SERVER_X25519_PUBLIC_KEY_B64` in `server-public-key.ts` is already the correct key.

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: X25519 encryption module
   Files: src/license/x25519-encrypt.ts (new), test/license/x25519-encrypt.test.ts (new)
   Requirements: Implement `encryptRequest(plaintext: string, serverPublicKeyB64: string): { ephemeral_public: string, nonce: string, ciphertext: string }`. Steps: (1) generate ephemeral X25519 keypair via `crypto.generateKeyPairSync('x25519')`, (2) perform ECDH: `crypto.diffieHellman({ privateKey: ephemeralPrivate, publicKey: serverPublic })` to get raw shared secret, (3) HKDF-SHA256 the shared secret with salt `'auto-sop-bind8-v1'` and info `'request-encryption'` to derive 32-byte AES key, (4) generate random 12-byte nonce, (5) AES-256-GCM encrypt plaintext, (6) return hex-encoded ephemeral public key + nonce + ciphertext+tag. Must match the server's `decryptRequest()` in `auto-sop-site/src/lib/x25519.ts`. Tests: verify roundtrip with a test keypair, verify different ephemeral key per call, verify tampered ciphertext fails.
   Acceptance: Unit tests pass. Output format matches server's expected input.

2. ARCHITECT: Verify HKDF compatibility with server
   Files: test/license/x25519-compat.test.ts (new)
   Requirements: Create a compatibility test that replicates the server's decrypt logic locally. Generate a keypair, encrypt with the CLI function, decrypt with the same algorithm the server uses (reimplemented in the test). This ensures the HKDF salt, info, and AES-GCM parameters match exactly. Read server's `src/lib/x25519.ts` from the auto-sop-site repo if accessible, otherwise hardcode the known parameters: HKDF salt `'auto-sop-bind8-v1'`, info `'request-encryption'`, AES-256-GCM with 12-byte nonce.
   Acceptance: Compatibility test proves encrypt→decrypt roundtrip works with matching parameters.

### Wave 2 (depends on Wave 1)

3. ARCHITECT: Wire encryption into validate request
   Files: src/license/server-client.ts
   Requirements: In `validateLicense()`, after building the JSON body string, call `encryptRequest(bodyString, SERVER_X25519_PUBLIC_KEY_B64)`. Send with `Content-Type: application/x-asop-encrypted` and the encrypted payload as the body (JSON stringified `{ ephemeral_public, nonce, ciphertext }`). Import `SERVER_X25519_PUBLIC_KEY_B64` from `server-public-key.ts`. Add try/catch around encryption — if it fails, fall back to unencrypted `application/json` request and log a warning. This ensures old Node.js versions or environments without X25519 support don't break.
   Acceptance: Validate requests are sent encrypted. Server decrypts and processes normally. Fallback to unencrypted works when encryption fails.

4. ARCHITECT: Integration test — encrypted validate roundtrip
   Files: test/license/bind8-integration.test.ts (new)
   Requirements: Mock the server's validate endpoint. Verify: (a) request has `Content-Type: application/x-asop-encrypted`, (b) body contains `ephemeral_public`, `nonce`, `ciphertext` fields, (c) decrypting with the test server private key yields the original validate payload with `key`, `machine_id`, `bound_projects`. Also test fallback: when `encryptRequest` throws, request falls back to plain JSON.
   Acceptance: Integration tests pass. Both encrypted and fallback paths tested.

## Quality Gates (MANDATORY)
5. YODA: Code review — encryption module, integration into server-client
6. APEX: Security review — key handling, HKDF parameters, no key material in logs, fallback security
7. ANALYZER: Code improvement review — must pass C or above

## Finalize
8. ARCHITECT: Commit all changes with message "feat(v40): BIND-8 CLI request encryption (X25519 + AES-256-GCM)"

## Acceptance Criteria
- All validate requests encrypted by default (Content-Type: application/x-asop-encrypted)
- Encryption uses ephemeral X25519 keypair per request (forward secrecy)
- HKDF parameters match server implementation exactly
- Graceful fallback to unencrypted on crypto failure
- No key material in logs or error messages
- SERVER_X25519_PUBLIC_KEY_B64 is no longer dead code
- All tests pass (100%)
- All quality gates approved
