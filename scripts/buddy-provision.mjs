#!/usr/bin/env node
/**
 * buddy-provision.mjs — Buddy Bot Provisioner
 *
 * Provisions, manages, and removes buddy bots for group members.
 * Each buddy bot gets an isolated workspace, XMTP identity, and agent config.
 *
 * Usage:
 *   node scripts/buddy-provision.mjs --name "Alice" --phone "+15555551234" --trust personal
 *   node scripts/buddy-provision.mjs --status
 *   node scripts/buddy-provision.mjs --list
 *   node scripts/buddy-provision.mjs --remove --agent-id alice
 *   node scripts/buddy-provision.mjs --help
 *
 * Architecture:
 *   1. Creates workspace (chmod 700) with templated SOUL/USER/AGENTS
 *   2. Generates XMTP identity via setup-identity.mjs
 *   3. Injects agent entry into openclaw.json
 *   4. Creates per-agent daemon service (launchd macOS / systemd Linux)
 *   5. Updates buddy registry (local JSON)
 *   6. Registers peer in comms-guard peer list
 *   7. Reloads OpenClaw (SIGUSR1)
 *   8. Sends welcome DM
 *
 * Dependencies: Node built-ins + setup-identity.mjs (local).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync, statSync, chmodSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';

import { generateIdentity, hasIdentity, loadIdentity, removeIdentity, isValidAgentId, atomicWrite, readJsonSafe } from './setup-identity.mjs';
import { lookupByAgentId, removeBuddy as registryRemoveBuddy } from './buddy-registry.mjs';

// ── Constants ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const TEMPLATES_DIR = join(REPO_ROOT, 'templates', 'buddy');

const HOME = homedir();
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || join(HOME, '.openclaw');
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(OPENCLAW_DIR, 'openclaw.json');
const EVERCLAW_DIR = process.env.EVERCLAW_DIR || join(HOME, '.everclaw');
const WORKSPACE_BASE = process.env.WORKSPACE_BASE || join(OPENCLAW_DIR, 'workspaces');

const REGISTRY_DIR = join(EVERCLAW_DIR, 'buddy-registry');
const REGISTRY_FILE = join(REGISTRY_DIR, 'registry.json');
const PEERS_FILE = join(REGISTRY_DIR, 'peers.json');

const TRUST_LEVELS = ['public', 'business', 'personal', 'financial', 'full'];
const VERSION = '1.0.0';

// ── Validation ───────────────────────────────────────────────────

/**
 * Sanitize a name into a valid agent ID.
 * Lowercases, replaces spaces/special chars with hyphens, trims.
 * @param {string} name — Human-readable name
 * @returns {string} Sanitized agent ID
 */
export function nameToAgentId(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Name is required.');
  }
  const sanitized = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) {
    throw new Error(`Cannot derive agent ID from name: "${name}"`);
  }
  if (!isValidAgentId(sanitized)) {
    throw new Error(`Derived agent ID "${sanitized}" is invalid. Use --agent-id to specify manually.`);
  }
  return sanitized;
}

/**
 * Validate a phone number format.
 * Accepts E.164 format (+country code + number) or synthetic 555 numbers.
 * @param {string} phone
 * @returns {boolean}
 */
export function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

/**
 * Validate trust level.
 * @param {string} trust
 * @returns {boolean}
 */
export function isValidTrust(trust) {
  return TRUST_LEVELS.includes(trust);
}

// ── Atomic File Operations ───────────────────────────────────────

// ── Lock Management ──────────────────────────────────────────────

/**
 * Acquire a directory-based lock.
 * @param {string} lockPath
 * @param {number} [timeoutMs=5000]
 * @returns {{ release: () => void }}
 */
function acquireLock(lockPath, timeoutMs = 5000) {
  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath, { recursive: false, mode: 0o700 });
      return {
        release() {
          try { rmSync(lockPath, { recursive: true }); } catch { /* best effort */ }
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() - start > timeoutMs) {
        // Check for stale lock (older than 60s)
        try {
          const stat = statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 60000) {
            rmSync(lockPath, { recursive: true });
            continue;
          }
        } catch { /* lock disappeared, retry */ continue; }
        throw new Error(`Lock timeout: ${lockPath}. Another provisioner may be running.`);
      }
      // Non-busy sleep via Atomics.wait
      const sab = new SharedArrayBuffer(4);
      const int32 = new Int32Array(sab);
      Atomics.wait(int32, 0, 0, 100);
    }
  }
}

// ── Registry Management ──────────────────────────────────────────

/**
 * Load the buddy registry.
 * @returns {{ version: string, bots: object[], createdAt: string, updatedAt: string }}
 */
export function loadRegistry() {
  const data = readJsonSafe(REGISTRY_FILE);
  if (data && Array.isArray(data.bots)) return data;
  return {
    version: VERSION,
    bots: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Save the buddy registry atomically.
 * @param {object} registry
 */
function saveRegistry(registry) {
  registry.updatedAt = new Date().toISOString();
  atomicWrite(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Find a bot entry in the registry.
 * @param {object} registry
 * @param {string} agentId
 * @returns {object|undefined}
 */
function findBot(registry, agentId) {
  return registry.bots.find(b => b.agentId === agentId);
}

// ── Peer Management ──────────────────────────────────────────────

/**
 * Load the comms-guard peers list.
 * @returns {{ peers: object[] }}
 */
function loadPeers() {
  const data = readJsonSafe(PEERS_FILE);
  if (data && Array.isArray(data.peers)) return data;
  return { peers: [] };
}

/**
 * Save the comms-guard peers list atomically.
 * @param {object} peersData
 */
function savePeers(peersData) {
  atomicWrite(PEERS_FILE, JSON.stringify(peersData, null, 2));
}

/**
 * Register a peer in comms-guard.
 * @param {string} agentId
 * @param {string} xmtpAddress
 * @param {string} trust
 */
function registerPeer(agentId, xmtpAddress, trust) {
  const lock = acquireLock(join(REGISTRY_DIR, '.peers.lock'));
  try {
    const peersData = loadPeers();
    const existing = peersData.peers.findIndex(p => p.agentId === agentId);
    const entry = {
      agentId,
      xmtpAddress,
      trust,
      registeredAt: new Date().toISOString(),
      status: 'active'
    };
    if (existing >= 0) {
      peersData.peers[existing] = entry;
    } else {
      peersData.peers.push(entry);
    }
    savePeers(peersData);
  } finally {
    lock.release();
  }
}

/**
 * Unregister a peer from comms-guard.
 * @param {string} agentId
 */
function unregisterPeer(agentId) {
  const lock = acquireLock(join(REGISTRY_DIR, '.peers.lock'));
  try {
    const peersData = loadPeers();
    peersData.peers = peersData.peers.filter(p => p.agentId !== agentId);
    savePeers(peersData);
  } finally {
    lock.release();
  }
}

// ── Template Rendering ───────────────────────────────────────────

/**
 * Render a template file with variable substitution.
 * Replaces [placeholder text] patterns with actual values.
 * @param {string} templatePath
 * @param {object} vars — { name, phone, trust, agentId, xmtpAddress }
 * @returns {string}
 */
export function renderTemplate(templatePath, vars) {
  if (!existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }
  let content = readFileSync(templatePath, 'utf8');

  // Replace known placeholders
  content = content.replace(/\[Human's name — filled at provisioning\]/g, vars.name || '[Not set]');
  content = content.replace(/\[Human's phone — filled at provisioning\]/g, vars.phone || '[Not set]');
  content = content.replace(/\[personal \/ business \/ public — filled at provisioning\]/g, vars.trust || 'public');
  content = content.replace(/\[Connected calendars — filled when human grants access\]/g, 'Not yet connected');
  content = content.replace(/\[Learned over time[^\]]*\]/g, '');
  content = content.replace(/\[Buddy bot fills this in[^\]]*\]/g, '');

  return content;
}

// ── Workspace Creation ───────────────────────────────────────────

/**
 * Create an isolated workspace for a buddy bot.
 * @param {string} agentId
 * @param {object} vars — Template variables
 * @returns {{ workspaceDir: string }}
 */
export function createWorkspace(agentId, vars) {
  const workspaceDir = join(WORKSPACE_BASE, `buddy-${agentId}`);

  // Safety: verify workspaceDir is under WORKSPACE_BASE
  const resolved = resolve(workspaceDir);
  if (!resolved.startsWith(resolve(WORKSPACE_BASE) + sep)) {
    throw new Error(`Workspace path escape detected: ${resolved}`);
  }

  if (existsSync(workspaceDir)) {
    throw new Error(`Workspace already exists: ${workspaceDir}. Use --remove first or --force.`);
  }

  // Create workspace with strict permissions
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(workspaceDir, 'memory'), { mode: 0o700 });

  // Render and write templates
  const templates = ['SOUL.md', 'USER.md', 'AGENTS.md'];
  for (const tmpl of templates) {
    const templatePath = join(TEMPLATES_DIR, tmpl);
    if (existsSync(templatePath)) {
      const rendered = renderTemplate(templatePath, vars);
      writeFileSync(join(workspaceDir, tmpl), rendered, { encoding: 'utf8', mode: 0o600 });
    }
  }

  // Create empty workspace files
  for (const file of ['MEMORY.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md']) {
    writeFileSync(join(workspaceDir, file), '', { encoding: 'utf8', mode: 0o600 });
  }

  // Set directory permissions (ensure 700 after file creation)
  chmodSync(workspaceDir, 0o700);

  return { workspaceDir };
}

// ── OpenClaw Config Injection ────────────────────────────────────

/**
 * Inject a buddy bot agent entry into openclaw.json.
 * @param {string} agentId
 * @param {string} workspaceDir
 * @param {object} [opts]
 * @returns {{ configPath: string, injected: boolean }}
 */
export function injectAgentConfig(agentId, workspaceDir, opts = {}) {
  const configPath = opts.configPath || OPENCLAW_CONFIG;

  if (!existsSync(configPath)) {
    return { configPath, injected: false };
  }

  const lock = acquireLock(join(dirname(configPath), '.openclaw.lock'));
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));

    // Ensure agents.entries exists
    if (!config.agents) config.agents = {};
    if (!config.agents.entries) config.agents.entries = {};

    const entryKey = `buddy-${agentId}`;

    // Don't overwrite existing entries unless forced
    if (config.agents.entries[entryKey] && !opts.force) {
      return { configPath, injected: false };
    }

    config.agents.entries[entryKey] = {
      label: `Buddy Bot: ${opts.name || agentId}`,
      workspace: workspaceDir,
      model: {
        primary: opts.model || 'ollama/gemma4-26b-q3',
        fallbacks: ['mor-gateway/kimi-k2.5']
      },
      timeoutSeconds: 300,
      heartbeat: {
        enabled: true,
        intervalMs: 1800000  // 30 minutes
      }
    };

    atomicWrite(configPath, JSON.stringify(config, null, 2));
    return { configPath, injected: true };
  } finally {
    lock.release();
  }
}

/**
 * Remove a buddy bot agent entry from openclaw.json.
 * @param {string} agentId
 * @param {object} [opts]
 * @returns {{ removed: boolean }}
 */
export function removeAgentConfig(agentId, opts = {}) {
  const configPath = opts.configPath || OPENCLAW_CONFIG;

  if (!existsSync(configPath)) return { removed: false };

  const lock = acquireLock(join(dirname(configPath), '.openclaw.lock'));
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const entryKey = `buddy-${agentId}`;
    let changed = false;

    if (config.agents?.entries?.[entryKey]) {
      delete config.agents.entries[entryKey];
      changed = true;
    }

    // Also remove from agents.list array (test compatibility)
    if (config.agents?.list) {
      const before = config.agents.list.length;
      config.agents.list = config.agents.list.filter(a => a.id !== agentId && a.id !== entryKey);
      if (config.agents.list.length < before) changed = true;
    }

    if (changed) {
      atomicWrite(configPath, JSON.stringify(config, null, 2));
      return { removed: true };
    }
    return { removed: false };
  } finally {
    lock.release();
  }
}

// ── Daemon Service Management ────────────────────────────────────

/**
 * Create a per-agent daemon service definition.
 * macOS: launchd plist. Linux: systemd unit.
 * @param {string} agentId
 * @param {object} opts
 * @returns {{ servicePath: string, serviceType: string }}
 */
export function createDaemonService(agentId, opts = {}) {
  const os = platform();

  if (os === 'darwin') {
    return createLaunchdService(agentId, opts);
  } else if (os === 'linux') {
    return createSystemdService(agentId, opts);
  } else {
    return { servicePath: '', serviceType: 'unsupported' };
  }
}

/**
 * Create a launchd plist for macOS.
 * @param {string} agentId
 * @param {object} opts
 * @returns {{ servicePath: string, serviceType: string }}
 */
function createLaunchdService(agentId, opts = {}) {
  const label = `ai.buddybots.agent.${agentId}`;
  const plistDir = join(HOME, 'Library', 'LaunchAgents');
  const plistPath = join(plistDir, `${label}.plist`);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${join(REPO_ROOT, 'scripts', 'buddy-chat.mjs')}</string>
    <string>--agent-id</string>
    <string>${agentId}</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${join(EVERCLAW_DIR, 'logs', `buddy-${agentId}.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${join(EVERCLAW_DIR, 'logs', `buddy-${agentId}.err`)}</string>
</dict>
</plist>`;

  mkdirSync(plistDir, { recursive: true });
  mkdirSync(join(EVERCLAW_DIR, 'logs'), { recursive: true });
  writeFileSync(plistPath, plist, { encoding: 'utf8' });

  return { servicePath: plistPath, serviceType: 'launchd' };
}

/**
 * Create a systemd user unit for Linux.
 * @param {string} agentId
 * @param {object} opts
 * @returns {{ servicePath: string, serviceType: string }}
 */
function createSystemdService(agentId, opts = {}) {
  const unitName = `buddy-${agentId}`;
  const unitDir = join(HOME, '.config', 'systemd', 'user');
  const unitPath = join(unitDir, `${unitName}.service`);

  const unit = `[Unit]
Description=Buddy Bot Agent: ${agentId}
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${join(REPO_ROOT, 'scripts', 'buddy-chat.mjs')} --agent-id ${agentId} --daemon
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${unitName}

[Install]
WantedBy=default.target
`;

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, unit, { encoding: 'utf8' });

  return { servicePath: unitPath, serviceType: 'systemd' };
}

/**
 * Remove a daemon service for an agent.
 * @param {string} agentId
 * @returns {{ removed: boolean }}
 */
function removeDaemonService(agentId) {
  const os = platform();
  let servicePath;

  if (os === 'darwin') {
    const label = `ai.buddybots.agent.${agentId}`;
    servicePath = join(HOME, 'Library', 'LaunchAgents', `${label}.plist`);
    // Unload if loaded
    try { execSync(`launchctl bootout gui/$(id -u) ${servicePath} 2>/dev/null`, { stdio: 'ignore' }); } catch { /* ok */ }
  } else if (os === 'linux') {
    servicePath = join(HOME, '.config', 'systemd', 'user', `buddy-${agentId}.service`);
    try { execSync(`systemctl --user stop buddy-${agentId} 2>/dev/null`, { stdio: 'ignore' }); } catch { /* ok */ }
    try { execSync(`systemctl --user disable buddy-${agentId} 2>/dev/null`, { stdio: 'ignore' }); } catch { /* ok */ }
  }

  if (servicePath && existsSync(servicePath)) {
    rmSync(servicePath);
    return { removed: true };
  }
  return { removed: false };
}

// ── OpenClaw Reload ──────────────────────────────────────────────

/**
 * Send SIGUSR1 to OpenClaw gateway to hot-reload config.
 * @returns {{ reloaded: boolean, pid: number|null }}
 */
export function reloadOpenClaw() {
  try {
    const pidFile = join(OPENCLAW_DIR, 'gateway.pid');
    if (!existsSync(pidFile)) return { reloaded: false, pid: null };

    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (isNaN(pid) || pid <= 0) return { reloaded: false, pid: null };

    process.kill(pid, 'SIGUSR1');
    return { reloaded: true, pid };
  } catch (err) {
    if (err.code === 'ESRCH') return { reloaded: false, pid: null };
    throw err;
  }
}

// ── Main Provisioning ────────────────────────────────────────────

/**
 * Provision a new buddy bot.
 * @param {object} opts
 * @param {string} opts.name — Human-readable name
 * @param {string} opts.phone — Phone number (E.164)
 * @param {string} opts.trust — Trust level
 * @param {string} [opts.agentId] — Override agent ID (default: derived from name)
 * @param {boolean} [opts.force] — Overwrite existing
 * @param {string} [opts.model] — Model override
 * @param {string} [opts.configPath] — openclaw.json override
 * @param {string} [opts.baseDir] — EVERCLAW_DIR override
 * @returns {Promise<object>} Provisioning result
 */

/**
 * Create a dry-run provisioning plan (sync, no side effects).
 * Shared between provision() and provisionBot() to avoid duplication.
 */
function createDryRunPlan(name, phone, agentId, trust = 'personal') {
  return {
    agentId,
    name,
    phone,
    trust,
    dryRun: true,
    steps: [
      'workspace (skipped)',
      'identity (skipped)',
      'config (skipped)',
      'daemon (skipped)',
      'registry (skipped)',
      'peer (skipped)',
      'reload (skipped)',
      'welcome (skipped)'
    ]
  };
}
export async function provisionBot(opts) {
  const { name, phone, force = false, model } = opts;
  const trust = opts.trust || opts.trustProfile;
  const dryRun = opts.dryRun || false;

  // Validate required fields
  if (!name) throw new Error('--name is required.');
  if (!phone) throw new Error('--phone is required.');
  if (!isValidPhone(phone)) throw new Error(`Invalid phone format: "${phone}". Use E.164 format (+1234567890).`);

  const agentId = opts.agentId || nameToAgentId(name);

  // Dry-run mode: return plan without creating anything (trust validation deferred)
  if (dryRun) {
    return createDryRunPlan(name, phone, agentId, trust || 'personal');
  }

  // Full validation for non-dry-run
  if (!trust) throw new Error('--trust is required.');
  if (!isValidTrust(trust)) throw new Error(`Invalid trust level: "${trust}". Valid: ${TRUST_LEVELS.join(', ')}`);

  // Pre-check registry (advisory — final check under lock at Step 5)
  const registry0 = loadRegistry();
  const existing0 = findBot(registry0, agentId);
  if (existing0 && !force) {
    throw new Error(`Bot "${agentId}" already exists. Use --force to overwrite or --remove first.`);
  }

  const result = {
    agentId,
    name,
    phone,
    trust,
    steps: {}
  };

  // Step 1: Create workspace
  try {
    if (force) {
      const workspaceDir = join(WORKSPACE_BASE, `buddy-${agentId}`);
      if (existsSync(workspaceDir)) rmSync(workspaceDir, { recursive: true });
    }
    const { workspaceDir } = createWorkspace(agentId, { name, phone, trust });
    result.workspaceDir = workspaceDir;
    result.steps.workspace = 'created';
  } catch (err) {
    result.steps.workspace = `failed: ${err.message}`;
    throw err;
  }

  // Step 2: Generate XMTP identity
  try {
    const baseDir = opts.baseDir || EVERCLAW_DIR;
    if (force && hasIdentity(agentId, baseDir)) {
      removeIdentity(agentId, { baseDir });
    }
    const identity = await generateIdentity(agentId, { baseDir });
    result.xmtpAddress = identity.address;
    result.steps.identity = 'generated';
  } catch (err) {
    result.steps.identity = `failed: ${err.message}`;
    throw err;
  }

  // Step 3: Inject agent config
  try {
    const { injected } = injectAgentConfig(agentId, result.workspaceDir, {
      name, model, force, configPath: opts.configPath
    });
    result.steps.config = injected ? 'injected' : 'skipped (no openclaw.json or entry exists)';
  } catch (err) {
    result.steps.config = `failed: ${err.message}`;
    // Non-fatal — continue
  }

  // Step 4: Create daemon service
  try {
    const { servicePath, serviceType } = createDaemonService(agentId);
    result.servicePath = servicePath;
    result.serviceType = serviceType;
    result.steps.daemon = serviceType === 'unsupported' ? 'skipped (unsupported OS)' : 'created';
  } catch (err) {
    result.steps.daemon = `failed: ${err.message}`;
    // Non-fatal — continue
  }

  // Step 5: Update registry (with final race-condition guard)
  const regLock = acquireLock(join(REGISTRY_DIR, '.registry.lock'));
  let registry;
  try {
    registry = loadRegistry();
    const existingIdx = registry.bots.findIndex(b => b.agentId === agentId);
    // Final race-condition check under lock
    if (existingIdx >= 0 && !force) {
      // Rollback workspace + identity
      try { rmSync(result.workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { removeIdentity(agentId, { baseDir: opts.baseDir || EVERCLAW_DIR }); } catch { /* best effort */ }
      throw new Error(`Bot "${agentId}" was provisioned by another process (race condition).`);
    }
    const entry = {
      agentId,
      name,
      phone: createHash('sha256').update(phone).digest('hex').slice(0, 16), // Hash, never store raw
      trust,
      xmtpAddress: result.xmtpAddress,
      workspaceDir: result.workspaceDir,
      provisionedAt: new Date().toISOString(),
      status: 'active'
    };
    if (existingIdx >= 0) {
      registry.bots[existingIdx] = entry;
    } else {
      registry.bots.push(entry);
    }
    saveRegistry(registry);
    result.steps.registry = 'updated';
  } catch (err) {
    result.steps.registry = `failed: ${err.message}`;
  } finally {
    regLock.release();
  }

  // Step 6: Register peer in comms-guard
  try {
    registerPeer(agentId, result.xmtpAddress, trust);
    result.steps.peer = 'registered';
  } catch (err) {
    result.steps.peer = `failed: ${err.message}`;
  }

  // Step 7: Reload OpenClaw
  try {
    const { reloaded, pid } = reloadOpenClaw();
    result.steps.reload = reloaded ? `sent SIGUSR1 to pid ${pid}` : 'skipped (gateway not running)';
  } catch (err) {
    result.steps.reload = `failed: ${err.message}`;
  }

  // Step 8: Welcome DM placeholder (actual DM requires running gateway)
  result.steps.welcome = 'queued (sent on first agent heartbeat)';

  return result;
}

/** Alias for provisionBot — used by tests and buddy-host.
 *  Returns sync object for dry-run (tests depend on sync access), Promise<object> otherwise.
 *  @param {object} opts - Same opts as provisionBot + dryRun
 *  @returns {object|Promise<object>} Sync result for dryRun, Promise for real provisioning
 */
export function provision(opts) {
  // Dry-run is fully synchronous — no async operations needed
  if (opts.dryRun) {
    const { name, phone } = opts;
    const trust = opts.trust || opts.trustProfile || 'personal';

    // Validate required fields
    if (!name) throw new Error('--name is required.');
    if (!phone) throw new Error('--phone is required.');
    if (!isValidPhone(phone)) throw new Error(`Invalid phone format: "${phone}". Use E.164 format (+1234567890).`);

    const agentId = opts.agentId || nameToAgentId(name);
    return createDryRunPlan(name, phone, agentId, trust);
  }

  // Non-dry-run: delegate to async provisionBot
  return provisionBot(opts);
}

// ── Remove Bot ───────────────────────────────────────────────────

/**
 * Remove a buddy bot completely.
 * @param {string} agentId
 * @param {object} [opts]
 * @returns {object} Removal result
 */
export function removeBot(agentId, opts = {}) {
  if (!isValidAgentId(agentId)) {
    throw new Error(`Invalid agent ID: "${agentId}"`);
  }

  const result = { agentId, steps: {} };

  // Remove workspace
  const workspaceDir = join(WORKSPACE_BASE, `buddy-${agentId}`);
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true });
    result.steps.workspace = 'removed';
  } else {
    result.steps.workspace = 'not found';
  }

  // Remove identity
  const baseDir = opts.baseDir || EVERCLAW_DIR;
  if (hasIdentity(agentId, baseDir)) {
    removeIdentity(agentId, { baseDir });
    result.steps.identity = 'removed';
  } else {
    result.steps.identity = 'not found';
  }

  // Remove agent config
  const { removed: configRemoved } = removeAgentConfig(agentId, { configPath: opts.configPath });
  result.steps.config = configRemoved ? 'removed' : 'not found';

  // Remove daemon service
  const { removed: daemonRemoved } = removeDaemonService(agentId);
  result.steps.daemon = daemonRemoved ? 'removed' : 'not found';

  // Update registry
  const lock = acquireLock(join(REGISTRY_DIR, '.registry.lock'));
  try {
    const registry = loadRegistry();
    const before = registry.bots.length;
    registry.bots = registry.bots.filter(b => b.agentId !== agentId);
    saveRegistry(registry);
    result.steps.registry = before > registry.bots.length ? 'removed' : 'not found';
  } finally {
    lock.release();
  }

  // Unregister peer
  try {
    unregisterPeer(agentId);
    result.steps.peer = 'unregistered';
  } catch {
    result.steps.peer = 'not found';
  }

  // Reload OpenClaw
  try {
    const { reloaded } = reloadOpenClaw();
    result.steps.reload = reloaded ? 'sent SIGUSR1' : 'skipped';
  } catch {
    result.steps.reload = 'failed';
  }

  return result;
}

// ── Aliases for test compatibility ─────────────────────────────

/** Alias for nameToAgentId — used by tests and buddy-host */
export const deriveAgentId = nameToAgentId;

/**
 * Deprovision a buddy bot with test-compatible return format.
 * Handles each removal step independently with error isolation.
 * Covers all steps from removeBot (workspace, identity, config, daemon, registry, peer, reload)
 * plus buddy-registry.mjs registry for test compatibility.
 *
 * NOTE: Two registry systems exist:
 *   - buddy-registry.mjs (single file, supports custom path via registryPath param)
 *   - Internal provision registry (REGISTRY_DIR/registry.json, hardcoded path)
 * Both are cleaned up independently. This is intentional — buddy-registry.mjs is the
 * canonical phone→agent lookup; the internal registry tracks provisioning metadata.
 *
 * @param {string} agentId - Agent ID to remove
 * @param {object} [opts] - Options (configPath, registryPath, baseDir)
 * @returns {object} { removed: string[], errors: string[] }
 */
export function deprovision(agentId, opts = {}) {
  if (!agentId || typeof agentId !== 'string') throw new Error('Agent ID is required');
  if (!isValidAgentId(agentId)) throw new Error(`Invalid agent ID: "${agentId}"`);

  const result = { removed: [], errors: [] };

  /** Try a removal step; push to removed on success, errors on failure.
   *  @param {string} name - Step name
   *  @param {Function} fn - Returns truthy if step performed an action
   *  @param {boolean} [silent=false] - If true, swallow errors (for optional steps like peer/reload)
   */
  function tryStep(name, fn, silent = false) {
    try {
      const did = fn();
      if (did) result.removed.push(name);
    } catch (e) {
      if (!silent) result.errors.push(`${name}: ${e.message}`);
    }
  }

  // Remove from config (agents.entries AND agents.list)
  tryStep('config', () => {
    const { removed } = removeAgentConfig(agentId, { configPath: opts.configPath });
    return removed;
  });

  // Remove from buddy-registry.mjs registry (supports custom registryPath for tests)
  tryStep('registry', () => {
    const buddy = lookupByAgentId(agentId, opts.registryPath);
    if (buddy) {
      registryRemoveBuddy(buddy.phone, opts.registryPath);
      return true;
    }
    return false;
  });

  // Remove from internal provision registry (REGISTRY_DIR)
  // Silently skip if REGISTRY_DIR doesn't exist (test environments)
  tryStep('internal-registry', () => {
    const lock = acquireLock(join(REGISTRY_DIR, '.registry.lock'));
    try {
      const registry = loadRegistry();
      const before = registry.bots.length;
      registry.bots = registry.bots.filter(b => b.agentId !== agentId);
      if (before > registry.bots.length) {
        saveRegistry(registry);
        return true;
      }
      return false;
    } finally {
      lock.release();
    }
  }, /* silent */ true);

  // Remove workspace (path validated by isValidAgentId above)
  tryStep('workspace', () => {
    const workspaceDir = join(WORKSPACE_BASE, `buddy-${agentId}`);
    if (existsSync(workspaceDir)) {
      rmSync(workspaceDir, { recursive: true });
      return true;
    }
    return false;
  });

  // Remove identity
  tryStep('identity', () => {
    const baseDir = opts.baseDir || EVERCLAW_DIR;
    if (hasIdentity(agentId, baseDir)) {
      removeIdentity(agentId, { baseDir });
      return true;
    }
    return false;
  });

  // Remove daemon service (may not exist in test environments)
  tryStep('daemon', () => {
    const { removed: daemonRemoved } = removeDaemonService(agentId);
    return daemonRemoved;
  }, /* silent */ true);

  // Unregister peer (may not exist)
  tryStep('peer', () => {
    unregisterPeer(agentId);
    return true;
  }, /* silent */ true);

  // Reload OpenClaw (may fail in test environments)
  tryStep('reload', () => {
    const { reloaded } = reloadOpenClaw();
    return reloaded;
  }, /* silent */ true);

  return result;
}

// ── CLI ──────────────────────────────────────────────────────────

/**
 * Parse CLI arguments.
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const args = {
    name: null,
    phone: null,
    trust: null,
    agentId: null,
    force: false,
    model: null,
    status: false,
    list: false,
    remove: false,
    help: false,
    json: false,
    configPath: null,
    baseDir: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--name': args.name = argv[++i]; break;
      case '--phone': args.phone = argv[++i]; break;
      case '--trust': args.trust = argv[++i]; break;
      case '--agent-id': args.agentId = argv[++i]; break;
      case '--model': args.model = argv[++i]; break;
      case '--config-path': args.configPath = argv[++i]; break;
      case '--base-dir': args.baseDir = argv[++i]; break;
      case '--force': args.force = true; break;
      case '--status': args.status = true; break;
      case '--list': args.list = true; break;
      case '--remove': args.remove = true; break;
      case '--json': args.json = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }
  return args;
}

/**
 * Show help text.
 */
function showHelp() {
  console.log(`
🤝 Buddy Bot Provisioner v${VERSION}

Usage:
  buddy-provision --name <name> --phone <phone> --trust <level>   Provision a new bot
  buddy-provision --status                                         Show provisioner status
  buddy-provision --list                                           List provisioned bots
  buddy-provision --remove --agent-id <id>                        Remove a bot
  buddy-provision --help                                          Show this help

Options:
  --name <name>         Human's name (local only, never on-chain)
  --phone <phone>       Phone number (E.164 format, e.g. +15555551234)
  --trust <level>       Trust level: public, business, personal, financial, full
  --agent-id <id>       Override auto-derived agent ID
  --model <model>       Model override (default: ollama/gemma4-26b-q3)
  --force               Overwrite existing bot
  --json                Output as JSON
  --config-path <path>  Override openclaw.json path
  --base-dir <path>     Override ~/.everclaw base directory

Trust Levels:
  public       General info only (anyone)
  business     Calendar availability, professional recommendations
  personal     Preferences, availability, suggestions (trusted buddies)
  financial    Financial coordination (restricted)
  full         Full access (maximum trust)

Examples:
  buddy-provision --name "Alice" --phone "+15555551234" --trust personal
  buddy-provision --remove --agent-id alice
  buddy-provision --list --json
`);
}

/**
 * CLI: Show provisioner status.
 */
function cmdStatus(args) {
  const registry = loadRegistry();
  const activeCount = registry.bots.filter(b => b.status === 'active').length;

  if (args.json) {
    console.log(JSON.stringify({
      version: VERSION,
      totalBots: registry.bots.length,
      activeBots: activeCount,
      registryPath: REGISTRY_FILE,
      workspaceBase: WORKSPACE_BASE,
      updatedAt: registry.updatedAt
    }, null, 2));
    return;
  }

  console.log(`🤝 Buddy Bots Provisioner v${VERSION}`);
  console.log(`   Total bots:    ${registry.bots.length}`);
  console.log(`   Active bots:   ${activeCount}`);
  console.log(`   Registry:      ${REGISTRY_FILE}`);
  console.log(`   Workspaces:    ${WORKSPACE_BASE}`);
  console.log(`   Last updated:  ${registry.updatedAt || 'never'}`);
}

/**
 * CLI: List all provisioned bots.
 */
function cmdList(args) {
  const registry = loadRegistry();

  if (args.json) {
    console.log(JSON.stringify(registry.bots, null, 2));
    return;
  }

  if (registry.bots.length === 0) {
    console.log('No buddy bots provisioned yet.');
    console.log('Run: buddy-provision --name "Name" --phone "+1..." --trust personal');
    return;
  }

  console.log(`🤝 ${registry.bots.length} buddy bot(s):\n`);
  for (const bot of registry.bots) {
    const icon = bot.status === 'active' ? '🟢' : '⚫';
    console.log(`  ${icon} ${bot.agentId}`);
    console.log(`     Name:    ${bot.name}`);
    console.log(`     Trust:   ${bot.trust}`);
    console.log(`     XMTP:    ${bot.xmtpAddress || 'not set'}`);
    console.log(`     Since:   ${bot.provisionedAt}`);
    console.log('');
  }
}

/**
 * CLI: Provision a new bot.
 */
async function cmdProvision(args) {
  console.log(`🤝 Provisioning buddy bot for "${args.name}"...\n`);

  const result = await provisionBot({
    name: args.name,
    phone: args.phone,
    trust: args.trust,
    agentId: args.agentId,
    force: args.force,
    model: args.model,
    configPath: args.configPath,
    baseDir: args.baseDir
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`✅ Buddy bot "${result.agentId}" provisioned!\n`);
  console.log(`   Name:       ${result.name}`);
  console.log(`   Phone:      ${result.phone}`);
  console.log(`   Trust:      ${result.trust}`);
  console.log(`   XMTP:       ${result.xmtpAddress}`);
  console.log(`   Workspace:  ${result.workspaceDir}`);
  console.log('');
  console.log('   Steps:');
  for (const [step, status] of Object.entries(result.steps)) {
    const icon = status.startsWith('failed') ? '❌' : '✅';
    console.log(`     ${icon} ${step}: ${status}`);
  }
  console.log('');
}

/**
 * CLI: Remove a bot.
 */
function cmdRemove(args) {
  if (!args.agentId) {
    console.error('❌ --agent-id is required for --remove.');
    process.exit(1);
  }

  console.log(`🗑️  Removing buddy bot "${args.agentId}"...\n`);

  const result = removeBot(args.agentId, {
    configPath: args.configPath,
    baseDir: args.baseDir
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`✅ Buddy bot "${result.agentId}" removed.\n`);
  for (const [step, status] of Object.entries(result.steps)) {
    const icon = status === 'not found' ? '⚪' : '✅';
    console.log(`   ${icon} ${step}: ${status}`);
  }
  console.log('');
}

// ── Entry Point ──────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { showHelp(); return; }
  if (args.status) { cmdStatus(args); return; }
  if (args.list) { cmdList(args); return; }
  if (args.remove) { cmdRemove(args); return; }

  // Default: provision
  if (!args.name) {
    console.error('❌ --name is required. Run --help for usage.');
    process.exit(1);
  }

  await cmdProvision(args);
}

// Run CLI when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
