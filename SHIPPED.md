# SHIPPED.md

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
