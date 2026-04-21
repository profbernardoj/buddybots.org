# Changelog

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
