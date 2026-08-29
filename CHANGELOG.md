# Changelog

## 2026.8.28.2116 — Full-Host Migration (Gap 8)

### Added — Full-Host Migration (Gap 8)
- **`scripts/migrate-export.mjs`** (614 lines) — Whole-host migration export
  - Single passphrase-encrypted bundle (AES-256-GCM + scrypt, format v2 / schema 2.0)
  - Collects: openclaw config ({{HOME}}-templated), runtime deps, cron jobs
    (JSON API import, never SQL), keychain secrets (matched by stored account),
    workspaces (main + workspace-* sub-agents), skills state with `.wanted` map
  - Prints out-of-band SHA-256 of the ENCRYPTED bundle for import verification
  - Role policy: `worker` imports crons disabled (no double execution)
  - Default keychain services, target platform, and passphrase all resolved
    via nullish coalescing (MIGRATE_PASSPHRASE env works from CLI)
- **`scripts/migrate-import.mjs`** (506 lines) — Whole-host migration import
  - `--expected-checksum` out-of-band tamper gate (hashes the raw encrypted
    file before decryption)
  - Mandatory in-bundle checksum validation incl. normalized manifest
    self-checksum; tampered payloads rejected
  - Outer-tar member whitelist + type whitelist (regular files + dirs only;
    rejects symlinks, hardlinks, device nodes, FIFOs) before extraction
  - Preflight (platform/openclaw as warnings, config conflict as blocker)
  - `--dry-run`, `--force`, burn behavior
  - Restores keychain secrets with the SAME `-a` account as the source
  - Cron import via gateway API staging (`pending-cron-import.json`)
- **`scripts/migrate.test.mjs`** (473 lines) — 37 tests: crypto round-trip, role
  policy, templating, preflight, tamper gates (payload, manifest
  self-checksum, out-of-band checksum incl. byte-flip), keychain account parsing,
  CLI default-parameter regression, env passphrase, preflight warnings
- **`docs/migration-runbook-template.md`** — Pre-planning template for migrations

### Audited
- Grok 4.20 (R1-R11) = **EXCELLENT**, 0 blocking
- Claude Opus 4.8 cross-model (R1-R5) = **EXCELLENT**, 0 blocking
  - R1: fixed default-param bypass (keychainServices [], targetPlatform null)
  - R2: fixed outer-tar zip-slip, fragile preflight test, help text, platform over-block
  - R3: fixed tar type whitelist (hardlinks/device nodes), openclaw preflight over-block
  - R4: fixed export passphrase null-vs-undefined
  - R5: Excellent — 0 Correctness/0 Security/0 Consistency
- PII scan: 0 findings

## v0.2.0 (2026-04-21)

### Added
- **`scripts/buddy-provision.mjs`** (1,000 lines) — Full buddy bot provisioner
  - Creates isolated workspace (chmod 700) with templated SOUL/USER/AGENTS
  - Generates XMTP identity via setup-identity.mjs
  - Injects agent entry into openclaw.json with atomic locking
  - Creates per-agent daemon service (launchd macOS / systemd Linux)
  - Updates buddy registry with race-condition-safe locking + rollback
  - Registers peer in comms-guard peer list
  - Reloads OpenClaw via SIGUSR1
  - CLI: --name, --phone, --trust, --status, --list, --remove, --json, --force
  - Phone numbers hashed in registry (never stored raw)

- **`scripts/setup-identity.mjs`** (794 lines) — XMTP identity lifecycle manager
  - Generate, import, export, verify, remove, list identities
  - Shared utilities: atomicWrite, readJsonSafe (DRY across all scripts)
  - Lazy-load viem (single import, fail-fast)
  - Per-agent storage: identity.json (public) + .secrets.json (chmod 600)
  - SHA-256 checksums for export bundles
  - CLI: --agent-id, --import, --export, --verify, --remove, --list

- **`scripts/buddy-chat.mjs`** (537 lines) — Chat CLI + daemon entry point
  - Send/receive messages with local JSONL store
  - Atomic JSONL append (tmp + rename)
  - Conversation index with preview and message counts
  - Message validation: length, control chars, injection patterns
  - Daemon mode with SIGINT/SIGTERM graceful shutdown
  - CLI: --agent-id, --send, --to, --list, --history, --daemon, --json

### Security
- Atomic file operations (tmp + rename) across all scripts
- Directory-based locking with stale-lock detection (Atomics.wait, no busy-wait)
- Race-condition guard in provisioner with rollback on collision
- Message validation blocks control chars, template literals, script injection
- Workspace isolation: chmod 700 directories, chmod 600 secrets
- Phone numbers SHA-256 hashed in registry
- No PII in any script or test file

### Audit
- Grok 4.20 (grok-4.20-0309-reasoning): 3 rounds → Perfect rating on all 3 files
- Round 1: DRY violations, race condition, busy-wait, weak validation
- Round 2: readJsonSafe dedup, lock paths, JSONL atomicity, validation tightening
- Round 3: ALL FILES PERFECT

## v0.1.0 (2026-04-12)

### Added
- Initial repo structure: templates, installer, SKILL.md, README.md
- `templates/SOUL.md` — buddy bot personality template
- `templates/USER.md` — owner profile template  
- `templates/AGENTS.md` — agent workspace instructions
- `buddy-bots-install.sh` — 6-step curl|bash installer
- Stub provisioner (buddy-provision.mjs --status/--list/--help only)
