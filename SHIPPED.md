# SHIPPED.md

## 2026.9.1.1315 — Source-Served Migration (Gap 8, Option D)

**SOP-001 Pipeline:** ALL STAGES COMPLETE (0-9). Stage 10 (real round-trip validation) pending — non-blocking.

### What Shipped

- `scripts/migrate-serve.mjs` (324 lines) — Source-side orchestrator
  - One-command-per-side LAN migration:
    - SOURCE: `node scripts/migrate-serve.mjs [--output-dir <dir>] [--role primary|worker] ...`
    - TARGET: `curl -fsSL http://<source-lan-ip>:18790/install/<token> | bash`
  - Runs export → starts `agent-download-server.mjs` → generates per-session
    install script (embeds URL + single-use UUID token + bundle SHA-256 +
    pinned OpenClaw version 2026.7.1-2) → prints the one-line curl command
  - Server self-terminates after bundle download or 15 min idle
- `scripts/migrate-serve.test.mjs` (205 lines) — 21 tests
- `scripts/agent-download-server.mjs` — new `--install-script`, `--scripts-dir`,
  `--keep-archive` args; migration endpoints under `/install/<token>`
- `scripts/migrate-export.mjs` (757 lines) — probes source OpenClaw version
  with pinned fallback; manifest records `openclawPinned`
- `scripts/migrate-import.mjs` (517 lines) — restores `workspaces.tar`
  (uncompressed) with `.tar.gz` fallback; `--dry-run` early-return; Node ≥ 22 gate
- `scripts/migrate.test.mjs` (549 lines) — 41 tests (was 37)
- Docs: SKILL.md, CHANGELOG.md, BUDDY_BOTS_README.md, `docs/migration-runbook-template.md`
  (Transfer Option A = source-served one-curl flow, Option B = manual offline)

### Security

- Token-gated HTTP endpoints (403 without the single-use token)
- Passphrase never embedded in the served script — prompted on target via `/dev/tty`
- Script checksums verified over HTTP before execution
- OpenClaw installed on target from pinned version (never `@latest`)
- Server binds `0.0.0.0` — exposure warning documented in SKILL.md + runbook

### Audit Trail

- Grok 4.20 R1-R5 = **EXCELLENT** (0 blocking); Stage 5 coverage R1 = EXCELLENT
- Claude Opus 4.8 R1-R4 = **Perfect** (0 blocking, cross-model)
- PII scan (Stage 6): 0 findings — RFC 5737 doc IPs in examples/tests
- Tests: migrate 41/41 · serve 21/21 · no regressions vs baseline

### Deployment

- 9 commits `1a73784`→`a44b85b`, Stage 8 primary deploy 2026-09-01
  (origin + EverClaw org, clean fast-forward, both remotes at `a44b85b`)

---

## 2026.8.28.2116 — Full-Host Migration Export/Import (Gap 8)

**SOP-001 Pipeline:** ALL STAGES COMPLETE (0-9). Stage 10 (real round-trip validation) pending — non-blocking.
**User guide:** `~/Documents/InstallOpenClaw/migrate-agent-guide.md`

### What Shipped

- `scripts/migrate-export.mjs` (614 lines) — Whole-host migration export
  - AES-256-GCM + scrypt encrypted bundle (format v2, schema 2.0)
  - Collects: config ({{HOME}}-templated), deps, crons, keychain secrets, workspaces, skills state
  - Out-of-band SHA-256 of encrypted file for tamper detection
  - Manifest self-checksum (normalized fixed-point)
  - Role policy: worker imports crons disabled

- `scripts/migrate-import.mjs` (506 lines) — Whole-host migration import
  - Out-of-band + in-bundle checksum validation
  - Outer + inner tar member whitelist + type whitelist (regular files + dirs only)
  - Preflight: warnings for platform/openclaw, block for config conflict
  - Keychain restore with same account as source
  - Cron import via gateway API staging

- `scripts/migrate.test.mjs` (473 lines) — 37 tests
- `docs/migration-runbook-template.md` — Pre-planning template

### Audit Trail

- Grok 4.20 R1-R11 = **EXCELLENT** (0 blocking)
- Claude Opus 4.8 R1-R5 = **EXCELLENT** (0 blocking, 5 rounds to converge)
- PII scan: 0 findings

### Blocking Bugs Fixed During Audit

1. keychainServices `[]` bypassed destructure default (R1)
2. targetPlatform `null` bypassed destructure default (R1)
3. Outer-tar zip-slip (R2)
4. Preflight test targeted wrong check (R2)
5. Help text mismatch (R2)
6. Platform mismatch hard block (R2)
7. Tar type whitelist incomplete (R3)
8. Openclaw preflight over-block (R3)
9. Export passphrase null-vs-undefined (R4)
