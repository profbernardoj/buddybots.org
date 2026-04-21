# Gap 1 Plan — Buddy Bots Flavor Repo Scripts

## Scope
Three scripts for the buddybots.org standalone flavor repo:

1. **`scripts/buddy-provision.mjs`** (~900 lines) — Full provisioner replacing existing 83-line stub
2. **`scripts/setup-identity.mjs`** (~500 lines) — XMTP identity lifecycle management
3. **`scripts/buddy-chat.mjs`** (~700 lines) — CLI for buddy bot messaging (debug/test tool)

## Modality
- **Platform:** buddybots.org flavor repo (standalone, not main EverClaw)
- **Runtime:** macOS native + Linux native
- **Node.js:** 22+ ESM with `node:` prefix for builtins
- **Dependencies:** viem (already in package.json) — no new deps needed

## Design Decisions

### Self-Contained
Scripts do NOT import from the main EverClaw repo at runtime. They contain their own:
- Registry management (inline, file-based JSON)
- Lock file management (mkdir-based, matches EverClaw patterns)
- Atomic file writes (tmp + rename pattern)
- XMTP identity generation (viem key generation + secure storage)

### Pattern Alignment
Follow patterns from existing EverClaw buddy-*.mjs scripts:
- JSDoc on all exports
- CLI arg parsing with `--` prefix flags
- Dual-use: CLI entry point + library exports
- `import.meta.url` detection for CLI vs library
- chmod 700 for directories, chmod 600 for sensitive files
- Atomic writes via tmp file + rename

### buddy-provision.mjs Architecture
1. Create workspace (chmod 700) with templated SOUL/USER/AGENTS
2. Generate XMTP identity (calls setup-identity logic, inline for standalone)
3. Inject agent entry into openclaw.json
4. Create per-agent daemon service (launchd on macOS, systemd on Linux)
5. Update buddy registry (local JSON)
6. Register peer in comms-guard
7. Reload OpenClaw (SIGUSR1)
8. Send welcome DM placeholder
9. CLI: --name, --phone, --trust, --status, --list, --remove, --help

### setup-identity.mjs Architecture
- Generate or import XMTP identity
- Store in per-agent directory (chmod 600)
- Verify identity (self-message test)
- Export identity for migration
- CLI: --agent-id, --import, --export, --verify, --help

### buddy-chat.mjs Architecture
- Send/receive messages as specific buddy bot
- List conversations
- Show message history
- Interactive and one-shot modes
- CLI: --agent-id, --send, --to, --list, --history, --help

## Regression Test Plan
- `bash -n buddy-bots-install.sh` must pass
- Templates (SOUL.md, USER.md, AGENTS.md) must be unmodified
- package.json scripts must resolve
- No new dependencies added

## Timeline
- Stage 1 (Planning): This document ✓
- Stage 2 (Coding + Grok Audit): Implement all 3, iterate to Perfect rating
- Stage 3 (Deps + Regression): Verify no regressions
- Stage 5 (Testing): Write + run tests
- Stage 6 (PII Scan): Zero PII findings
- Stage 7 (Documentation): Update CHANGELOG
