# Migration Runbook Template (Gap 8)

Use this template to document a specific host-to-host migration. The export
script generates a tailored RUNBOOK.md inside each bundle; this template is
for planning the migration before running export.

## Source Host

- **Hostname:** ___
- **Platform:** macOS / Linux
- **OpenClaw version:** ___
- **Role:** primary / worker
- **Workspace count:** ___ (main + sub-agents)

## Target Host

- **Hostname:** ___
- **Platform:** macOS / Linux
- **OpenClaw version:** ___ (install from dependency manifest if fresh)

## Pre-Export Checklist

- [ ] Source agent running (verify with `openclaw status`)
- [ ] Keychain services present (`security find-generic-password -s venice-key1` etc.)
- [ ] Cron jobs exported (`openclaw cron list --json` or `--crons <file>`)
- [ ] Workspaces clean (no large temp files)
- [ ] Passphrase chosen (min 16 chars; use `MIGRATE_PASSPHRASE` env, NOT `--passphrase` argv)

## Export

```bash
# Set passphrase via env (keeps it out of ps/history)
export MIGRATE_PASSPHRASE='your-very-long-passphrase-here'

node scripts/migrate-export.mjs \
  --output ~/Documents/migrate-bundle-<date>.tar.gz.enc \
  --role primary
```

The exporter prints:
- Bundle path
- Workspace count, cron count, keychain count (and any missing)
- **SHA-256 of the encrypted bundle file** — copy this (out-of-band checksum)

## Transfer

- Copy the `.tar.gz.enc` file to the target host (AirDrop, rsync, USB)
- **Communicate the SHA-256 checksum via a DIFFERENT channel** (Signal, voice, paper)
- The checksum guards against tampering during transfer

## Import (on target host)

```bash
# Set passphrase via env
export MIGRATE_PASSPHRASE='your-very-long-passphrase-here'

node scripts/migrate-import.mjs \
  --import ~/Downloads/migrate-bundle-<date>.tar.gz.enc \
  --expected-checksum <sha-256-from-export>
```

The importer:
1. Verifies the encrypted file matches the out-of-band checksum
2. Decrypts and validates in-bundle per-file checksums (incl. manifest self-checksum)
3. Runs preflight checks (platform, openclaw, config conflict)
4. Restores config, keychain, workspaces, skills state
5. Stages cron jobs at `~/.openclaw/pending-cron-import.json`
6. Copies the generated RUNBOOK.md to `~/Documents/`

## Post-Import Checklist

- [ ] Install dependencies from the dependency manifest (`brew install node`, `npm install -g openclaw@latest`, plugins, ollama models)
- [ ] Re-enable skills (agent reads `pending-cron-import.json` and creates each cron job via gateway API)
- [ ] Run `openclaw doctor` — verify skills are healthy
- [ ] Relink Signal (one number per instance — not portable)
- [ ] Send a test message to the agent
- [ ] Compare keychain entries (`security find-generic-password -s venice-key1` etc.)
- [ ] Verify cron jobs are active (`openclaw cron list`)

## Burn (after verification)

```bash
rm -f '<path-to-bundle.tar.gz.enc>'
```

The bundle contains live secrets. Delete it after successful verification.

## Not Portable (by design)

- **Signal account:** one number per instance — relink separately
- **Session history:** non-portable across OpenClaw versions
- **Wallet key:** not under a known keychain service — export separately if needed

## Troubleshooting

- **"passphrase required"** — set `MIGRATE_PASSPHRASE` env var (min 16 chars)
- **"checksum MISMATCH"** — the encrypted file was modified during transfer; do not import
- **"bundle integrity check FAILED"** — a file inside the bundle was modified; do not import
- **"unsafe bundle member rejected"** — the bundle contains unexpected files; do not import
- **"openclaw NOT installed"** — normal on a fresh target; install from the dependency manifest
- **"platform MISMATCH"** — warning only; config/workspaces are portable, verify binaries
