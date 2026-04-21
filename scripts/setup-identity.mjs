#!/usr/bin/env node
/**
 * setup-identity.mjs — XMTP Identity Manager for Buddy Bots
 *
 * Generates, imports, exports, and verifies XMTP identities for buddy bot agents.
 * Each agent gets its own keypair stored in a per-agent directory with strict permissions.
 *
 * Usage:
 *   node scripts/setup-identity.mjs --agent-id alice
 *   node scripts/setup-identity.mjs --agent-id alice --verify
 *   node scripts/setup-identity.mjs --agent-id alice --export --output /tmp/alice-identity.json
 *   node scripts/setup-identity.mjs --agent-id alice --import /path/to/identity-bundle.json
 *   node scripts/setup-identity.mjs --list
 *   node scripts/setup-identity.mjs --help
 *
 * Storage layout (per agent):
 *   ~/.everclaw/xmtp-<agentId>/
 *     identity.json    — public identity (address, network, metadata)
 *     .secrets.json    — private key + DB encryption key (chmod 600)
 *
 * Dependencies: viem (for key generation), Node built-ins only otherwise.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { homedir, platform } from 'node:os';

// ── Constants ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const HOME = homedir();
const EVERCLAW_DIR = process.env.EVERCLAW_DIR || join(HOME, '.everclaw');

const IDENTITY_FILENAME = 'identity.json';
const SECRETS_FILENAME = '.secrets.json';
const IDENTITY_VERSION = '1.0';
const NETWORK = 'production';

// Export bundle envelope version
const BUNDLE_VERSION = '1.0';

// ── Validation ───────────────────────────────────────────────────

/**
 * Validate an agent ID is safe for filesystem use.
 * @param {string} agentId
 * @returns {boolean}
 */
export function isValidAgentId(agentId) {
  if (!agentId || typeof agentId !== 'string') return false;
  if (agentId.length < 1 || agentId.length > 64) return false;
  // Allow lowercase alphanum, hyphens, underscores. No leading/trailing hyphens.
  return /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(agentId) || /^[a-z0-9]$/.test(agentId);
}

/**
 * Validate an Ethereum address format (0x + 40 hex chars).
 * @param {string} addr
 * @returns {boolean}
 */
function isValidAddress(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/**
 * Validate a hex private key (0x + 64 hex chars).
 * @param {string} key
 * @returns {boolean}
 */
function isValidPrivateKey(key) {
  return typeof key === 'string' && /^0x[0-9a-fA-F]{64}$/.test(key);
}

// ── Path Helpers ─────────────────────────────────────────────────

/**
 * Get the identity directory for an agent.
 * @param {string} agentId
 * @param {string} [baseDir] — Override base directory for testing.
 * @returns {string}
 */
export function getIdentityDir(agentId, baseDir = EVERCLAW_DIR) {
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent ID: "${agentId}". Must be 1-64 lowercase alphanumeric, hyphens, underscores.`);
  }
  return join(baseDir, `xmtp-${agentId}`);
}

/**
 * Get the identity file path for an agent.
 * @param {string} agentId
 * @param {string} [baseDir]
 * @returns {string}
 */
export function getIdentityPath(agentId, baseDir = EVERCLAW_DIR) {
  return join(getIdentityDir(agentId, baseDir), IDENTITY_FILENAME);
}

/**
 * Get the secrets file path for an agent.
 * @param {string} agentId
 * @param {string} [baseDir]
 * @returns {string}
 */
export function getSecretsPath(agentId, baseDir = EVERCLAW_DIR) {
  return join(getIdentityDir(agentId, baseDir), SECRETS_FILENAME);
}

// ── Atomic File Operations ───────────────────────────────────────

/**
 * Write a file atomically with restricted permissions.
 * Uses tmp + rename pattern for crash safety.
 * @param {string} filePath
 * @param {string} content
 * @param {number} [mode=0o600]
 */
export function atomicWrite(filePath, content, mode = 0o600) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = filePath + '.tmp.' + randomUUID().slice(0, 8);
  const finalContent = typeof content === 'string'
    ? (content.endsWith('\n') ? content : content + '\n')
    : JSON.stringify(content, null, 2) + '\n';
  writeFileSync(tmp, finalContent, { encoding: 'utf8', mode });
  renameSync(tmp, filePath);
}

/**
 * Read a JSON file safely, returning null if missing/invalid.
 * @param {string} filePath
 * @returns {object|null}
 */
export function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ── Key Generation ───────────────────────────────────────────────

/**
 * Generate a new XMTP keypair using viem.
 * @returns {Promise<{ privateKey: string, address: string }>}
 */
// ── Viem Lazy Load (fail-fast, single import) ───────────────────

let _viemLoaded = false;
let _generatePrivateKey, _privateKeyToAccount;

async function loadViem() {
  if (_viemLoaded) return;
  try {
    const viemAccounts = await import('viem/accounts');
    _generatePrivateKey = viemAccounts.generatePrivateKey;
    _privateKeyToAccount = viemAccounts.privateKeyToAccount;
    _viemLoaded = true;
  } catch {
    throw new Error('viem is required for key generation. Run: npm install viem');
  }
}

async function generateKeypair() {
  await loadViem();
  const privateKey = _generatePrivateKey();
  const account = _privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}

/**
 * Derive an address from an existing private key using viem.
 * @param {string} privateKey — Hex private key (0x...)
 * @returns {Promise<string>} Ethereum address
 */
async function deriveAddress(privateKey) {
  await loadViem();
  const account = _privateKeyToAccount(privateKey);
  return account.address;
}

/**
 * Derive a DB encryption key from a private key.
 * Deterministic — same key always produces the same DB key.
 * @param {string} privateKey — Hex private key
 * @returns {string} Hex SHA-256 hash
 */
function deriveDbKey(privateKey) {
  return createHash('sha256')
    .update('xmtp-buddy-bots:db:' + privateKey)
    .digest('hex');
}

// ── Identity CRUD ────────────────────────────────────────────────

/**
 * Check if an agent already has an identity configured.
 * @param {string} agentId
 * @param {string} [baseDir]
 * @returns {boolean}
 */
export function hasIdentity(agentId, baseDir = EVERCLAW_DIR) {
  const identityPath = getIdentityPath(agentId, baseDir);
  const secretsPath = getSecretsPath(agentId, baseDir);
  return existsSync(identityPath) && existsSync(secretsPath);
}

/**
 * Load an agent's identity (public data only).
 * @param {string} agentId
 * @param {string} [baseDir]
 * @returns {object|null} Identity object or null if not found.
 */
export function loadIdentity(agentId, baseDir = EVERCLAW_DIR) {
  const identityPath = getIdentityPath(agentId, baseDir);
  if (!existsSync(identityPath)) return null;
  const data = readJsonSafe(identityPath);
  if (!data || !data.address || !data.version) return null;
  return data;
}

/**
 * Load an agent's secrets (private key + DB key).
 * @param {string} agentId
 * @param {string} [baseDir]
 * @returns {object|null} Secrets object or null if not found.
 */
function loadSecrets(agentId, baseDir = EVERCLAW_DIR) {
  const secretsPath = getSecretsPath(agentId, baseDir);
  if (!existsSync(secretsPath)) return null;
  const data = readJsonSafe(secretsPath);
  if (!data || !data.privateKey) return null;
  return data;
}

/**
 * Generate a new XMTP identity for an agent.
 * Idempotent — returns existing identity if already configured.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.baseDir] — Override base directory for testing.
 * @param {boolean} [opts.force=false] — Overwrite existing identity.
 * @returns {Promise<{ address: string, created: boolean, identityDir: string }>}
 */
export async function generateIdentity(agentId, opts = {}) {
  const { baseDir = EVERCLAW_DIR, force = false } = opts;

  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent ID: "${agentId}"`);
  }

  const identityDir = getIdentityDir(agentId, baseDir);
  const identityPath = getIdentityPath(agentId, baseDir);
  const secretsPath = getSecretsPath(agentId, baseDir);

  // Idempotent check
  if (!force && hasIdentity(agentId, baseDir)) {
    const existing = loadIdentity(agentId, baseDir);
    if (existing && existing.address) {
      return { address: existing.address, created: false, identityDir };
    }
  }

  // If forcing, remove old identity
  if (force && existsSync(identityDir)) {
    rmSync(identityDir, { recursive: true, force: true });
  }

  // Generate keypair
  const { privateKey, address } = await generateKeypair();
  const dbEncryptionKey = deriveDbKey(privateKey);

  // Create identity directory
  mkdirSync(identityDir, { recursive: true, mode: 0o700 });

  // Write secrets (chmod 600)
  const secrets = {
    privateKey,
    dbEncryptionKey,
    generatedAt: new Date().toISOString()
  };
  atomicWrite(secretsPath, JSON.stringify(secrets, null, 2) + '\n', 0o600);

  // Write identity (public data)
  const identity = {
    version: IDENTITY_VERSION,
    address,
    inboxId: null, // Set on first daemon connection
    network: NETWORK,
    flavor: 'buddy-bots',
    agentId,
    createdAt: new Date().toISOString()
  };
  atomicWrite(identityPath, JSON.stringify(identity, null, 2) + '\n', 0o600);

  return { address, created: true, identityDir };
}

/**
 * Import an XMTP identity from a bundle (JSON with privateKey + identity metadata).
 *
 * Bundle format:
 *   {
 *     "bundleVersion": "1.0",
 *     "agentId": "alice",
 *     "privateKey": "0x...",
 *     "address": "0x...",
 *     "network": "production",
 *     "metadata": { ... }
 *   }
 *
 * @param {string} agentId — Target agent ID (must match bundle or --force).
 * @param {string} bundlePath — Path to the import bundle JSON file.
 * @param {object} [opts]
 * @param {string} [opts.baseDir]
 * @param {boolean} [opts.force=false] — Import even if agent ID doesn't match bundle.
 * @returns {Promise<{ address: string, imported: boolean, identityDir: string }>}
 */
export async function importIdentity(agentId, bundlePath, opts = {}) {
  const { baseDir = EVERCLAW_DIR, force = false } = opts;

  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent ID: "${agentId}"`);
  }

  if (!existsSync(bundlePath)) {
    throw new Error(`Import bundle not found: ${bundlePath}`);
  }

  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid bundle JSON: ${err.message}`);
  }

  // Validate bundle structure
  if (!bundle.privateKey || !isValidPrivateKey(bundle.privateKey)) {
    throw new Error('Bundle must contain a valid privateKey (0x + 64 hex chars)');
  }

  // Verify address matches private key
  const derivedAddress = await deriveAddress(bundle.privateKey);
  if (bundle.address && bundle.address.toLowerCase() !== derivedAddress.toLowerCase()) {
    throw new Error(
      `Bundle address mismatch: bundle says ${bundle.address} but key derives to ${derivedAddress}`
    );
  }

  // Check agent ID match
  if (bundle.agentId && bundle.agentId !== agentId && !force) {
    throw new Error(
      `Bundle agent ID "${bundle.agentId}" doesn't match target "${agentId}". Use --force to override.`
    );
  }

  // Check for existing identity
  if (hasIdentity(agentId, baseDir) && !force) {
    throw new Error(
      `Agent "${agentId}" already has an identity. Use --force to overwrite.`
    );
  }

  const identityDir = getIdentityDir(agentId, baseDir);
  const identityPath = getIdentityPath(agentId, baseDir);
  const secretsPath = getSecretsPath(agentId, baseDir);

  // Clean up existing if forcing
  if (existsSync(identityDir)) {
    rmSync(identityDir, { recursive: true, force: true });
  }

  // Create identity directory
  mkdirSync(identityDir, { recursive: true, mode: 0o700 });

  // Write secrets
  const dbEncryptionKey = deriveDbKey(bundle.privateKey);
  const secrets = {
    privateKey: bundle.privateKey,
    dbEncryptionKey,
    importedAt: new Date().toISOString(),
    importedFrom: bundlePath
  };
  atomicWrite(secretsPath, JSON.stringify(secrets, null, 2) + '\n', 0o600);

  // Write identity
  const address = derivedAddress;
  const identity = {
    version: IDENTITY_VERSION,
    address,
    inboxId: bundle.inboxId || null,
    network: bundle.network || NETWORK,
    flavor: 'buddy-bots',
    agentId,
    createdAt: bundle.createdAt || new Date().toISOString(),
    importedAt: new Date().toISOString()
  };
  atomicWrite(identityPath, JSON.stringify(identity, null, 2) + '\n', 0o600);

  return { address, imported: true, identityDir };
}

/**
 * Export an agent's identity as a portable bundle.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.baseDir]
 * @param {string} [opts.output] — Output file path. If omitted, returns the bundle object.
 * @returns {{ bundle: object, outputPath: string|null }}
 */
export function exportIdentity(agentId, opts = {}) {
  const { baseDir = EVERCLAW_DIR, output } = opts;

  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent ID: "${agentId}"`);
  }

  const identity = loadIdentity(agentId, baseDir);
  if (!identity) {
    throw new Error(`No identity found for agent "${agentId}"`);
  }

  const secrets = loadSecrets(agentId, baseDir);
  if (!secrets) {
    throw new Error(`No secrets found for agent "${agentId}" (identity exists but secrets missing)`);
  }

  const bundle = {
    bundleVersion: BUNDLE_VERSION,
    agentId,
    privateKey: secrets.privateKey,
    address: identity.address,
    inboxId: identity.inboxId || null,
    network: identity.network,
    createdAt: identity.createdAt,
    exportedAt: new Date().toISOString(),
    metadata: {
      flavor: identity.flavor,
      version: identity.version
    }
  };

  if (output) {
    atomicWrite(output, JSON.stringify(bundle, null, 2) + '\n', 0o600);
    return { bundle, outputPath: output };
  }

  return { bundle, outputPath: null };
}

/**
 * Verify an agent's identity is valid and internally consistent.
 *
 * Checks:
 *   1. Identity file exists and is valid JSON
 *   2. Secrets file exists and is valid JSON
 *   3. Private key derives to the stored address
 *   4. DB encryption key is consistent
 *   5. File permissions are correct (unix only)
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.baseDir]
 * @returns {Promise<{ valid: boolean, checks: Array<{ name: string, passed: boolean, detail: string }> }>}
 */
export async function verifyIdentity(agentId, opts = {}) {
  const { baseDir = EVERCLAW_DIR } = opts;
  const checks = [];

  /** Add a check result. */
  function check(name, passed, detail = '') {
    checks.push({ name, passed, detail });
    return passed;
  }

  // 1. Identity file
  const identityPath = getIdentityPath(agentId, baseDir);
  const identity = loadIdentity(agentId, baseDir);
  if (!check('identity-file-exists', existsSync(identityPath), identityPath)) {
    return { valid: false, checks };
  }
  check('identity-file-valid', identity !== null, 'Parsed successfully');

  // 2. Secrets file
  const secretsPath = getSecretsPath(agentId, baseDir);
  const secrets = loadSecrets(agentId, baseDir);
  if (!check('secrets-file-exists', existsSync(secretsPath), secretsPath)) {
    return { valid: false, checks };
  }
  check('secrets-file-valid', secrets !== null, 'Parsed successfully');

  if (!identity || !secrets) {
    return { valid: false, checks };
  }

  // 3. Private key → address derivation
  let derivedAddress;
  try {
    derivedAddress = await deriveAddress(secrets.privateKey);
    check(
      'key-address-match',
      derivedAddress.toLowerCase() === identity.address.toLowerCase(),
      `Derived: ${derivedAddress}, Stored: ${identity.address}`
    );
  } catch (err) {
    check('key-address-match', false, `Derivation failed: ${err.message}`);
  }

  // 4. DB key consistency
  const expectedDbKey = deriveDbKey(secrets.privateKey);
  check(
    'db-key-consistent',
    secrets.dbEncryptionKey === expectedDbKey,
    'DB encryption key matches derivation'
  );

  // 5. File permissions (POSIX only)
  if (platform() !== 'win32') {
    try {
      const identityStat = statSync(identityPath);
      const secretsStat = statSync(secretsPath);
      const dirStat = statSync(getIdentityDir(agentId, baseDir));

      const dirMode = dirStat.mode & 0o777;
      check('dir-permissions', dirMode === 0o700, `Expected 0700, got 0${dirMode.toString(8)}`);

      const secretsMode = secretsStat.mode & 0o777;
      check('secrets-permissions', secretsMode === 0o600, `Expected 0600, got 0${secretsMode.toString(8)}`);

      const identityMode = identityStat.mode & 0o777;
      check('identity-permissions', identityMode === 0o600, `Expected 0600, got 0${identityMode.toString(8)}`);
    } catch (err) {
      check('permissions', false, `stat failed: ${err.message}`);
    }
  }

  const valid = checks.every(c => c.passed);
  return { valid, checks };
}

/**
 * Remove an agent's identity completely.
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.baseDir]
 * @returns {boolean} True if identity was found and removed.
 */
export function removeIdentity(agentId, opts = {}) {
  const { baseDir = EVERCLAW_DIR } = opts;
  const identityDir = getIdentityDir(agentId, baseDir);
  if (!existsSync(identityDir)) return false;
  rmSync(identityDir, { recursive: true, force: true });
  return true;
}

/**
 * List all agent identities found in the base directory.
 * @param {string} [baseDir]
 * @returns {Array<{ agentId: string, address: string, createdAt: string, identityDir: string }>}
 */
export function listIdentities(baseDir = EVERCLAW_DIR) {
  if (!existsSync(baseDir)) return [];

  const entries = readdirSync(baseDir, { withFileTypes: true });
  const identities = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('xmtp-')) continue;

    const agentId = entry.name.slice('xmtp-'.length);
    if (!isValidAgentId(agentId)) continue;

    const identity = loadIdentity(agentId, baseDir);
    if (!identity) continue;

    identities.push({
      agentId,
      address: identity.address,
      createdAt: identity.createdAt,
      network: identity.network,
      identityDir: join(baseDir, entry.name)
    });
  }

  return identities.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

// ── CLI ──────────────────────────────────────────────────────────

/**
 * Parse CLI arguments.
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agent-id' && argv[i + 1]) args.agentId = argv[++i];
    else if (arg === '--import' && argv[i + 1]) args.importPath = argv[++i];
    else if (arg === '--export') args.export = true;
    else if (arg === '--output' && argv[i + 1]) args.output = argv[++i];
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--remove') args.remove = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--base-dir' && argv[i + 1]) args.baseDir = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

/**
 * Print CLI help text.
 */
function showHelp() {
  console.log(`
🔑 Buddy Bots Identity Manager

Usage:
  setup-identity --agent-id <id>                        Generate new identity
  setup-identity --agent-id <id> --verify               Verify identity integrity
  setup-identity --agent-id <id> --export [--output <p>] Export identity bundle
  setup-identity --agent-id <id> --import <bundle.json>  Import identity from bundle
  setup-identity --agent-id <id> --remove                Remove identity
  setup-identity --list                                  List all identities

Options:
  --agent-id <id>     Agent identifier (required for most commands)
  --verify            Verify identity file integrity + key derivation
  --export            Export identity as portable bundle
  --output <path>     Output path for export (default: stdout as JSON)
  --import <path>     Import identity from a bundle file
  --remove            Remove an agent's identity completely
  --list              List all configured identities
  --force             Overwrite existing identity on generate/import
  --base-dir <path>   Override identity storage directory (for testing)
  --help              Show this help
  `);
}

/**
 * CLI: Generate a new identity.
 * @param {object} args
 */
async function cmdGenerate(args) {
  const result = await generateIdentity(args.agentId, {
    baseDir: args.baseDir,
    force: args.force
  });

  if (result.created) {
    console.log(`✅ Identity created for agent "${args.agentId}"`);
  } else {
    console.log(`ℹ️  Identity already exists for agent "${args.agentId}"`);
  }
  console.log(`   Address:  ${result.address}`);
  console.log(`   Location: ${result.identityDir}`);
}

/**
 * CLI: Verify an identity.
 * @param {object} args
 */
async function cmdVerify(args) {
  const result = await verifyIdentity(args.agentId, { baseDir: args.baseDir });

  console.log(`🔍 Identity verification for "${args.agentId}":\n`);
  for (const check of result.checks) {
    const icon = check.passed ? '✅' : '❌';
    const detail = check.detail ? ` — ${check.detail}` : '';
    console.log(`  ${icon} ${check.name}${detail}`);
  }
  console.log('');
  if (result.valid) {
    console.log('✅ All checks passed.');
  } else {
    console.log('❌ Verification failed.');
    process.exit(1);
  }
}

/**
 * CLI: Export an identity.
 * @param {object} args
 */
function cmdExport(args) {
  const { bundle, outputPath } = exportIdentity(args.agentId, {
    baseDir: args.baseDir,
    output: args.output
  });

  if (outputPath) {
    console.log(`✅ Identity exported to ${outputPath}`);
    console.log(`   Address: ${bundle.address}`);
    console.log(`   ⚠️  Contains private key — store securely!`);
  } else {
    // Output to stdout for piping
    console.log(JSON.stringify(bundle, null, 2));
  }
}

/**
 * CLI: Import an identity.
 * @param {object} args
 */
async function cmdImport(args) {
  const result = await importIdentity(args.agentId, args.importPath, {
    baseDir: args.baseDir,
    force: args.force
  });

  console.log(`✅ Identity imported for agent "${args.agentId}"`);
  console.log(`   Address:  ${result.address}`);
  console.log(`   Location: ${result.identityDir}`);
}

/**
 * CLI: Remove an identity.
 * @param {object} args
 */
function cmdRemove(args) {
  const removed = removeIdentity(args.agentId, { baseDir: args.baseDir });
  if (removed) {
    console.log(`🗑️  Identity removed for agent "${args.agentId}".`);
  } else {
    console.log(`⚠️  No identity found for agent "${args.agentId}".`);
    process.exit(1);
  }
}

/**
 * CLI: List all identities.
 * @param {object} args
 */
function cmdList(args) {
  const identities = listIdentities(args.baseDir);
  if (identities.length === 0) {
    console.log('No identities configured.');
    return;
  }
  console.log(`🔑 ${identities.length} identity/identities:\n`);
  for (const id of identities) {
    console.log(`  ${id.agentId}`);
    console.log(`    Address:  ${id.address}`);
    console.log(`    Network:  ${id.network}`);
    console.log(`    Created:  ${id.createdAt}`);
    console.log(`    Location: ${id.identityDir}`);
    console.log('');
  }
}

// ── Entry Point ──────────────────────────────────────────────────

/**
 * Main CLI entry point.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { showHelp(); return; }
  if (args.list) { cmdList(args); return; }

  // All other commands require --agent-id
  if (!args.agentId) {
    console.error('❌ --agent-id is required. Run --help for usage.');
    process.exit(1);
  }

  if (args.verify) { await cmdVerify(args); return; }
  if (args.export) { cmdExport(args); return; }
  if (args.importPath) { await cmdImport(args); return; }
  if (args.remove) { cmdRemove(args); return; }

  // Default: generate
  await cmdGenerate(args);
}

// Run CLI when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
