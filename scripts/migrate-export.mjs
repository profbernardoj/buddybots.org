#!/usr/bin/env node
/**
 * migrate-export.mjs — Full-Host Migration Export (Gap 8)
 *
 * Exports everything needed to move an OpenClaw agent host to a new machine
 * as a single passphrase-encrypted bundle (AES-256-GCM, scrypt KDF).
 *
 * Proven live 2026-08-27 (Mac mini → MacBook Pro "bernardo3" migration).
 * Use cases: local→local machine move; hosted→local designed in this gap
 * (implementation deferred — see gap8-migration-plan.md §4.3).
 *
 * Usage:
 *   node migrate-export.mjs [--output <path>] [--passphrase <pw|env:MIGRATE_PASSPHRASE>]
 *                           [--role primary|worker] [--crons <cron-jobs.json>]
 *                           [--keychain-service <svc>]... [--dry-run] [--help]
 *
 * Bundle (v2, encrypted):
 *   manifest.json            — schema, host info, versions, role, excluded, checksum
 *   dependency-manifest.json — brew/npm/plugins/ollama with install commands
 *   config.json.tmpl         — openclaw.json with {{HOME}} literalized
 *   keychain.json.enc        — secret map, AES-256-GCM (bundle passphrase)
 *   cron-jobs.json           — cron definitions (JSON, version-tolerant)
 *   workspaces.tar.gz        — main workspace + sub-agent workspaces
 *   skills-state.json        — skills.entries enabled map
 *   RUNBOOK.md               — generated ordered steps for THIS bundle
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync,
         createReadStream, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir, tmpdir, arch, platform, EOL } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { STATE_DIR, OPENCLAW_DIR } from './paths.mjs';

const MANIFEST_VERSION = '2.0';
const MIN_PASSPHRASE_LEN = 16;
const BUNDLE_NAME_STEM = 'migrate-bundle';

// Known plugin-id → npm package map (proven 2026-08-27 on bernardo3).
const PLUGIN_NPM_MAP = {
  signal: '@openclaw/signal',
  brave: '@openclaw/brave-plugin',
  venice: '@openclaw/venice-provider',
  'llama-cpp': '@openclaw/llama-cpp-provider',
};

// ── Version / env probing ────────────────────────────────────────

function probeVersion(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000 }).trim();
  } catch { return null; }
}

function probeHost() {
  return {
    platform: platform(),
    arch: arch(),
    node: process.version,
    openclaw: probeVersion('openclaw', ['--version']),
    ollamaModels: probeOllamaModels(),
  };
}

function probeOllamaModels() {
  try {
    const out = execFileSync('ollama', ['list'], { encoding: 'utf8', timeout: 15000 });
    return out.trim().split('\n').slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean);
  } catch { return null; }
}

// ── Dependency manifest (L1, L2) ─────────────────────────────────

/**
 * Build the dependency manifest from live host state + config.
 * @param {object} cfg parsed openclaw.json
 */
export function buildDependencyManifest(cfg, targetPlatform = process.platform) {
  const deps = { brew: [], casks: [], npmGlobal: [], plugins: [], ollamaModels: [], commands: [], unknownPlugins: [] };

  const pluginEntries = cfg?.plugins?.entries || {};
  for (const [id, entry] of Object.entries(pluginEntries)) {
    if (entry && entry.enabled === false) continue;
    if (PLUGIN_NPM_MAP[id]) {
      deps.plugins.push({ id, npm: PLUGIN_NPM_MAP[id] });
      deps.commands.push(`openclaw plugins install ${PLUGIN_NPM_MAP[id]}`);
    } else {
      deps.unknownPlugins.push(id);
      deps.commands.push(`# plugin "${id}": no known npm package — install manually`);
    }
  }

  for (const model of probeOllamaModels() || []) {
    deps.ollamaModels.push(model);
    // R8 minor: these are SOURCE-observed models. On a hosted→ClawBox target
    // they may be irrelevant — the runbook note tells the user to edit as
    // needed for target hardware.
    deps.commands.push(`ollama pull ${model}   # source-observed; edit for target hardware`);
  }

  // Core runtime requirements (L1): node + openclaw. Platform-aware (R4/R7):
  // commands are generated for the TARGET machine, not the source — so a
  // Linux-hosted bundle can still tell a macOS ClawBox user to `brew install`.
  // Explicitly: brew is macOS-only; Linux targets use apt/npm.
  if (targetPlatform === 'darwin') {
    deps.commands.unshift('# Core runtime:', 'brew install node', 'npm install -g openclaw@latest');
  } else if (targetPlatform === 'linux') {
    deps.commands.unshift('# Core runtime:', 'apt-get update && apt-get install -y nodejs npm', 'npm install -g openclaw@latest');
  } else {
    deps.commands.unshift('# Core runtime:', 'npm install -g openclaw@latest');
  }

  return deps;
}

// ── Config templating (L3) ───────────────────────────────────────

/**
 * Literalize the home path in a config object into a template string.
 * @param {object} cfg
 * @param {string} home
 * @returns {{ template: string, hits: number }}
 */
export function templateConfig(cfg, home = homedir()) {
  // Documented limitation (Grok R6 minor): a whole-JSON regex literalizes the
  // home path everywhere. Any config value that legitimately contains the
  // source home as a substring would be mutated too. Proven on bernardo3
  // (47 hits, all genuine paths). If false positives ever appear, replace with
  // a JSON walker that only rewrites known path-bearing fields.
  const raw = JSON.stringify(cfg, null, 2);
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'g');
  const hits = (raw.match(re) || []).length;
  return { template: raw.replace(re, '{{HOME}}'), hits };
}

/**
 * Restore a config template for a target home.
 * @param {string} template
 * @param {string} home
 */
export function untemplateConfig(template, home = homedir()) {
  return template.split('{{HOME}}').join(home);
}

// ── Skills state (L2, L10) ───────────────────────────────────────

export function extractSkillsState(cfg) {
  // Lesson L2/L10 (bernardo3): `openclaw doctor` disables skills whose binaries
  // are missing, so the OBSERVED state is not the DESIRED state. Export both:
  //   .enabled    — what the config says NOW (may be doctor-disabled)
  //   .wanted     — DESIRED: any skill present in the source config is wanted
  //                 once its binaries exist. Doctor-disabled skills typically
  //                 CARRY a disabledReason (binary/doctor), so excluding by
  //                 reason would defeat L2 exactly when it matters (Grok R9).
  // Import re-enables anything `wanted:true` that landed disabled after deps
  // install — this makes the runbook's "re-enable after deps" claim true.
  const out = {};
  const entries = cfg?.skills?.entries || {};
  for (const [name, entry] of Object.entries(entries)) {
    const enabled = entry?.enabled !== false;
    out[name] = {
      enabled,
      // A skill present in the source config is wanted once deps exist.
      wanted: true,
    };
  }
  return out;
}

// ── Cron export (L4, L5) ─────────────────────────────────────────

/**
 * Load cron jobs. Tries `openclaw cron list --json`, else an explicit file.
 * Never SQL — schema differs across OpenClaw versions (L4, proven 2026-08-27).
 * @returns {{ jobs: object[], source: string }}
 */
export function loadCronJobs(explicitFile = null) {
  if (explicitFile) {
    // Normalize the explicit-file case the same way as the live CLI path
    // (Grok R4 minor): accept a bare array or { jobs: [...] } root.
    const parsed = JSON.parse(readFileSync(explicitFile, 'utf8'));
    const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || []);
    return { jobs, source: explicitFile };
  }
  try {
    const out = execFileSync('openclaw', ['cron', 'list', '--json'], {
      encoding: 'utf8', timeout: 30000,
    });
    const parsed = JSON.parse(out);
    const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || []);
    return { jobs, source: 'openclaw cron list --json' };
  } catch {
    return { jobs: null, source: 'unavailable' };
  }
}

/**
 * Apply role policy to cron jobs (L5): worker → all jobs disabled.
 */
export function applyCronRole(jobs, role) {
  if (!Array.isArray(jobs)) return jobs;
  if (role !== 'worker') return jobs;
  return jobs.map(j => ({ ...j, enabled: false }));
}

// ── Keychain export (L6) ─────────────────────────────────────────

const DEFAULT_KEYCHAIN_SERVICES = [
  'venice-key1', 'venice-key2', 'xai-grok45-api-key',
  'supabase-service-key', 'manifest-testnet-mnemonic',
];

/**
 * Collect secrets from macOS keychain. Values are never written in cleartext
 * to the staging dir — only into the encrypted blob.
 */
export function collectKeychainSecrets(services = DEFAULT_KEYCHAIN_SERVICES, account = process.env.USER || 'openclaw') {
  if (platform() !== 'darwin') return { secrets: {}, missing: services.slice(), account };
  const secrets = {};
  const missing = [];
  for (const svc of services) {
    try {
      // Match account to the item's existing account when one is stored
      // (Grok R8: the import side must use the SAME -a value, else keys are
      // misclassified as present/skipped on a differently-named target).
      // Claude M1: capture the QUOTED value only — `security` emits
      // "acct"<blob>="bernardo"; the old [^\s]+ regex kept the quotes and
      // the follow-up -a lookup failed, silently dropping the secret.
      const found = execFileSync('security', ['find-generic-password', '-s', svc], {
        encoding: 'utf8', timeout: 10000,
      });
      const acct = parseKeychainAccount(found, account);
      const val = execFileSync('security', ['find-generic-password', '-a', acct, '-s', svc, '-w'], {
        encoding: 'utf8', timeout: 10000,
      }).trim();
      if (val) secrets[svc] = { value: val, account: acct }; else missing.push(svc);
    } catch { missing.push(svc); }
  }
  return { secrets, missing, account };
}

/**
 * Parse the account name out of `security find-generic-password -s <svc>`
 * output. The attribute line is `"acct"<blob>="bernardo"` — only the quoted
 * value is the account. Returns the fallback when the line is absent or the
 * value is empty (e.g. <NULL> or a hex blob). Exported for unit tests.
 */
export function parseKeychainAccount(found, fallback) {
  const m = found.match(/"acct"<blob>="([^"]*)"/);
  return m && m[1] ? m[1] : fallback;
}

// ── Crypto (same format as buddy-export.mjs identity blobs) ──────

const KDF_OPTS = { N: 16384, r: 8, p: 1 };

export function encryptBuffer(plaintext, passphrase) {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, KDF_OPTS);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, ciphertext]);
}

export function decryptBuffer(blob, passphrase) {
  if (blob.length < 44) throw new Error('Encrypted blob too short');
  const salt = blob.subarray(0, 16);
  const iv = blob.subarray(16, 28);
  const tag = blob.subarray(28, 44);
  const ciphertext = blob.subarray(44);
  const key = scryptSync(passphrase, salt, 32, KDF_OPTS);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── Workspace packing (L12) ──────────────────────────────────────

/**
 * Find all workspace directories under the openclaw dir:
 * main workspace/ plus workspace-* sub-agent workspaces.
 */
export function findWorkspaces(openclawDir = OPENCLAW_DIR) {
  const found = [];
  if (!existsSync(openclawDir)) return found;
  for (const name of readdirSync(openclawDir)) {
    if (name === 'workspace' || name.startsWith('workspace-')) {
      const p = join(openclawDir, name);
      try { if (statSync(p).isDirectory()) found.push({ name, path: p }); } catch { /* skip */ }
    }
  }
  return found;
}

// ── Runbook generation ───────────────────────────────────────────

export function generateRunbook(manifest, deps) {
  const roleNote = manifest.role === 'worker'
    ? 'ROLE=worker: all cron jobs import DISABLED to avoid double execution.'
    : 'ROLE=primary: cron jobs import enabled.';
  const lines = [
    '# Migration Runbook (generated)', '',
    `Source host: ${manifest.source.host} (${manifest.source.platform}/${manifest.source.arch})`,
    `OpenClaw: ${manifest.source.openclaw || 'unknown'} · Node: ${manifest.source.node}`,
    `Role: ${manifest.role} — ${roleNote}`, '',
    '## 1. Core runtime + dependencies',
    '```', ...deps.commands, '```', '',
    '## 2. Import this bundle',
    '```',
    `node migrate-import.mjs --import ${BUNDLE_NAME_STEM}-<timestamp>.tar.gz.enc`,
    '```', '',
    '## 3. VERIFY before importing (tamper check)',
    'The export script prints the SHA-256 of the ENCRYPTED bundle file to the',
    'terminal. Compare it with the bundle you hold BEFORE importing (out-of-band).',
    'That value is deliberately NOT stored inside this bundle: a file cannot',
    'contain a hash of its own final bytes, so any in-bundle checksum would be',
    'recomputable by a tamperer. In-bundle per-file checksums in manifest.json',
    'guard against ACCIDENTAL corruption; the out-of-band hash guards against',
    'deliberate tampering.', '',
    '## 4. Cron jobs',
    manifest.excluded.crons
      ? 'Cron jobs NOT included in this bundle. Recreate them manually.'
      : 'Restored by the import script from cron-jobs.json (never SQL).\nAfter import: pending jobs are staged at ~/.openclaw/pending-cron-import.json —\nhave your agent create each one with the cron tool (gateway API).', '',
    '## 5. Not portable (excluded by design)',
    `- Signal account link: one Signal number per instance (L7) — relink separately.`,
    `- Session history: non-portable across versions (L13).`,
    ...Object.entries(manifest.excluded).filter(([, v]) => v).map(([k]) => `- ${k}`), '',
    '## 6. After import',
    '1. Run the verification checklist printed by the import script.',
    '2. Send a test message to the agent.',
    '3. DELETE the bundle file — it contains live secrets (L14).', '',
  ];
  return lines.join(EOL);
}

// ── Export ───────────────────────────────────────────────────────

/**
 * Build the migration bundle.
 * @param {object} options
 * @param {string} [options.output]
 * @param {string} options.passphrase
 * @param {string} [options.role=primary]
 * @param {string} [options.cronsFile]
 * @param {string[]} [options.keychainServices]
 * @param {string} [options.openclawDir] — override for testing
 * @param {string} [options.stagingDir] — override for testing
 * @param {boolean} [options.dryRun=false]
 */
export function exportMigrateBundle(options = {}) {
  const {
    output = null,
    role = 'primary',
    cronsFile = null,
    openclawDir = OPENCLAW_DIR,
    dryRun = false,
  } = options;

  // Claude R1 fix: resolve keychainServices and targetPlatform explicitly
  // (parseArgs seeds [] and null, bypassing destructure defaults).
  const keychainServices =
    (Array.isArray(options.keychainServices) && options.keychainServices.length)
      ? options.keychainServices
      : DEFAULT_KEYCHAIN_SERVICES;
  const targetPlatform = options.targetPlatform ?? process.platform;

  // Claude R4 fix: same null-vs-undefined bug as keychainServices/targetPlatform.
  // parseArgs seeds passphrase: null, bypassing the destructure default.
  // Use nullish coalescing so MIGRATE_PASSPHRASE env works (recommended path
  // to keep the secret out of ps/history).
  const passphrase = options.passphrase ?? process.env.MIGRATE_PASSPHRASE ?? null;

  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(`passphrase required (min ${MIN_PASSPHRASE_LEN} chars)`);
  }
  if (!['primary', 'worker'].includes(role)) {
    throw new Error(`role must be primary|worker, got: ${role}`);
  }
  if (!existsSync(join(openclawDir, 'openclaw.json'))) {
    throw new Error(`openclaw.json not found in ${openclawDir}`);
  }

  const cfg = JSON.parse(readFileSync(join(openclawDir, 'openclaw.json'), 'utf8'));
  const { template: configTmpl, hits: pathHits } = templateConfig(cfg, homedir());
  const host = probeHost();
  const deps = buildDependencyManifest(cfg, targetPlatform);
  const skillsState = extractSkillsState(cfg);

  // Crons (L4: JSON only, never SQL)
  const cronRaw = loadCronsFileCompat(cronsFile);
  const crons = applyCronRole(cronRaw.jobs, role);
  const excluded = {
    crons: !crons,
    signalLink: true,   // always — one number per instance (L7)
    sessionHistory: true, // always — non-portable (L13)
    walletKey: keychainMissingWallet(),
  };

  // Keychain secrets (encrypted, never cleartext on disk)
  const kc = collectKeychainSecrets(keychainServices);

  const checksumOf = (s) => createHash('sha256').update(s).digest('hex');

  const manifest = {
    schemaVersion: MANIFEST_VERSION,
    created: new Date().toISOString(),
    role,
    source: { host: hostnameSafe(), platform: host.platform, arch: host.arch, node: host.node, openclaw: host.openclaw },
    configPathHitsLiteralized: pathHits,
    keychainImported: Object.keys(kc.secrets),
    keychainMissing: kc.missing,
    ollamaModels: host.ollamaModels || [],
    excluded,
  };

  if (dryRun) {
    return { manifest, deps, skillsState, cronCount: Array.isArray(crons) ? crons.length : 0, dryRun: true };
  }

  // Stage everything
  const stage = options.stagingDir || join(tmpdir(), `${BUNDLE_NAME_STEG()}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });

  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  writeFileSync(join(stage, 'dependency-manifest.json'), JSON.stringify(deps, null, 2), { mode: 0o600 });
  writeFileSync(join(stage, 'config.json.tmpl'), configTmpl, { mode: 0o600 });
  writeFileSync(join(stage, 'skills-state.json'), JSON.stringify(skillsState, null, 2), { mode: 0o600 });

  if (crons) {
    writeFileSync(join(stage, 'cron-jobs.json'), JSON.stringify(crons, null, 2), { mode: 0o600 });
  }

  // Workspaces tar.gz (L12: includes sub-agent workspaces automatically)
  const workspaces = findWorkspaces(openclawDir);
  if (workspaces.length > 0) {
    execFileSync('tar', ['-czf', join(stage, 'workspaces.tar.gz'),
      '-C', openclawDir, ...workspaces.map(w => w.name)], { timeout: 300000 });
  }

  // Encrypted keychain map (inner layer; the outer bundle tar is encrypted too —
  // same passphrase, so this adds no cryptographic strength. Defense-in-depth /
  // future-proofing: the map stays opaque if the outer layer is ever decrypted
  // for inspection or a future key-change flow (Grok R7 minor note).)
  writeFileSync(join(stage, 'keychain.json.enc'),
    encryptBuffer(Buffer.from(JSON.stringify(kc), 'utf8'), passphrase), { mode: 0o600 });

  // Runbook: NEVER embeds the out-of-band checksum. A file cannot contain a
  // hash of its own final bytes (fixed point), so any in-bundle value would be
  // recomputable by a tamperer. The exporter prints the SHA-256 of the
  // ENCRYPTED bundle to the terminal; that out-of-band value is the tamper
  // gate (Claude audit B1 fix).
  writeFileSync(join(stage, 'RUNBOOK.md'), generateRunbook(manifest, deps), { mode: 0o600 });
  // Payload list for checksumming (finalized after the runbook write below).
  const payloadFiles = ['dependency-manifest.json', 'config.json.tmpl', 'skills-state.json', 'RUNBOOK.md'];
  if (crons) payloadFiles.push('cron-jobs.json');
  if (workspaces.length > 0) payloadFiles.push('workspaces.tar.gz');
  payloadFiles.push('keychain.json.enc');

  // Single definitive tar pass (no two-pass: nothing inside the bundle needs
  // the out-of-band hash). Plaintext tars live only in a private 0o700 tmp
  // dir, never next to the output (Grok R2 fix).
  const outPath = output || join(homedir(), 'Documents', `${BUNDLE_NAME_STEM}-${timestamp()}.tar.gz.enc`);
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  const tmpTarDir = mkdtempSync(join(tmpdir(), 'mig-tar-'));
  chmodSync(tmpTarDir, 0o700);
  const tarPath = join(tmpTarDir, 'bundle.tar.gz');
  let bundleChecksum = null;
  try {
    // Finalize manifest: per-file SHA-256 checksums of the staged payload files
    // exactly as they will ship.
    const finalChecksums = {};
    for (const f of payloadFiles) {
      finalChecksums[f] = createHash('sha256').update(readFileSync(join(stage, f))).digest('hex');
    }
    manifest.checksums = finalChecksums;

    // Self-checksum (Grok R9/R10): the in-bundle checksum guarantee must cover
    // the manifest that carries the table. A file cannot hash the exact bytes
    // that contain its own hash (fixed point), so both sides hash the manifest
    // with the self-reference normalized to a fixed placeholder (''). The value
    // is stored in the on-disk manifest; import recomputes it the same way.
    manifest.checksums['manifest.json'] = '';
    const selfBuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    const selfHash = createHash('sha256').update(selfBuf).digest('hex');
    manifest.checksums['manifest.json'] = selfHash;
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

    // Definitive tar + encrypt to the output path.
    execFileSync('tar', ['-czf', tarPath, '-C', stage, '.'], { timeout: 300000 });
    const finalTar = readFileSync(tarPath);
    writeFileSync(outPath, encryptBuffer(finalTar, passphrase), { mode: 0o600 });
    // B1 fix (Claude audit): the out-of-band checksum is the SHA-256 of the
    // ENCRYPTED FILE — the exact artifact the operator holds and imports.
    bundleChecksum = checksumOf(readFileSync(outPath));
  } finally {
    rmSync(tmpTarDir, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }

  return {
    outputPath: resolve(outPath),
    manifest,
    bundleChecksum,
    deps,
    workspaceCount: workspaces.length,
    cronCount: Array.isArray(crons) ? crons.length : 0,
    keychainCount: Object.keys(kc.secrets).length,
    keychainMissing: kc.missing,
    dryRun: false,
  };
}

// ── helpers ──────────────────────────────────────────────────────

function loadCronsFileCompat(cronsFile) {
  const r = loadCronJobs(cronsFile);
  if (r.jobs === null) {
    return { jobs: null, source: r.source };
  }
  return r;
}

function keychainMissingWallet() {
  // Wallet key is not under a known keychain service (lesson from bernardo3 L11)
  try {
    execFileSync('security', ['find-generic-password', '-s', 'morpheus-wallet-key', '-w'],
      { encoding: 'utf8', timeout: 10000 });
    return false;
  } catch { return true; }
}

function hostnameSafe() {
  try { return execFileSync('hostname', { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
}

function BUNDLE_NAME_STEG() {
  return `${BUNDLE_NAME_STEM}-stage-${process.pid}-${randomBytes(4).toString('hex')}`;
}

// ── CLI ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { output: null, passphrase: null, role: 'primary', cronsFile: null,
    keychainServices: [], targetPlatform: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) { console.error(`❌ ${a} requires a value`); process.exit(1); } return argv[++i]; };
    switch (a) {
      case '--output': args.output = val(); break;
      case '--passphrase': args.passphrase = val(); break;
      case '--role': args.role = val(); break;
      case '--crons': args.cronsFile = val(); break;
      case '--target-platform': args.targetPlatform = val(); break;
      case '--keychain-service': args.keychainServices.push(val()); break;
      case '--dry-run': args.dryRun = true; break;
      case '--help': args.help = true; break;
      default: console.error(`❌ Unknown flag: ${a}`); process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`migrate-export — Full-Host Migration Export (Gap 8)

Usage:
  node migrate-export.mjs [--output <path>] [--role primary|worker] [--dry-run]

Flags:
  --output <path>            Output .tar.gz.enc path (default ~/Documents/)
  --passphrase <pw>         Bundle passphrase — PREFER MIGRATE_PASSPHRASE env
                            (argv is visible in ps/history). Min 16 chars.
  --role primary|worker      worker = import all crons DISABLED (default primary)
  --crons <file>             Use this cron-jobs.json instead of live CLI export
  --target-platform <p>      Generate install commands for this target platform
                             (darwin|linux; default: source host platform)
  --keychain-service <svc>   Extra keychain service to include (repeatable)
  --dry-run                  Show plan without writing anything
  --help                     This help

SECURITY: the bundle is encrypted (AES-256-GCM, scrypt). Delete it after import.`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate-export.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }
  try {
    const res = exportMigrateBundle(args);
    if (res.dryRun) {
      console.log('DRY RUN — no files written.');
      console.log(JSON.stringify({ manifest: res.manifest, cronCount: res.cronCount, deps: res.deps.commands }, null, 2));
    } else {
      console.log(`✅ Bundle: ${res.outputPath}`);
      console.log(`   workspaces: ${res.workspaceCount} · crons: ${res.cronCount} · keychain: ${res.keychainCount} (missing: ${res.keychainMissing.join(', ') || 'none'})`);
      console.log(`   config paths literalized: ${res.manifest.configPathHitsLiteralized}`);
      console.log(`   SHA-256 (encrypted bundle file): ${res.bundleChecksum}`);
      console.log(`   Short match: ${res.bundleChecksum ? res.bundleChecksum.slice(0, 12) : 'n/a'} — compare this value with the bundle BEFORE importing (out-of-band)`);
      console.log('⚠️  DELETE this bundle after successful import — it contains live secrets.');
    }
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
