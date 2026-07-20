#!/usr/bin/env node
/**
 * buddy-export.mjs — Scoped Agent Export & Import (Gap 7)
 *
 * Export a single buddy bot's data (workspace, XMTP identity, registry entry)
 * as a portable tar.gz archive. Import it on another host to restore.
 *
 * Usage:
 *   node buddy-export.mjs --agent-id alice [--output path] [--dry-run] [--no-xmtp]
 *   node buddy-export.mjs --import archive.tar.gz [--force]
 *   node buddy-export.mjs --list
 *   node buddy-export.mjs --help
 *
 * Archive structure:
 *   manifest.json        — metadata (agentId, timestamp, checksums)
 *   workspace/           — agent workspace (~/.openclaw/workspace-{agentId})
 *   xmtp-identity/       — XMTP keypair (~/.everclaw/xmtp-{agentId})
 *   registry-entry.json  — buddy registry entry for this agent
 *   peer-entry.json      — peer registration for this agent
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync,
         statSync, createReadStream, cpSync, readlinkSync } from 'node:fs';
import { join, basename, dirname, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash, createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { OPENCLAW_DIR, STATE_DIR, EVERCLAW_DIR } from './paths.mjs';

// ── Constants ────────────────────────────────────────────────────

const HOME = homedir();
const REGISTRY_PATH = join(STATE_DIR, 'buddy-registry.json');
const PEERS_PATH = join(STATE_DIR, 'xmtp', 'peers.json');

const MANIFEST_VERSION = '1.0';
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024; // 500MB safety limit

// ── Path Helpers ─────────────────────────────────────────────────

/**
 * Get all data paths for an agent.
 * @param {string} agentId
 * @returns {object}
 */
export function getAgentPaths(agentId, options = {}) {
  if (!agentId || typeof agentId !== 'string' || agentId.trim() === '') {
    throw new Error('agentId is required (non-empty string)');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    throw new Error('agentId must contain only alphanumeric characters, dashes, and underscores');
  }

  const openclawDir = options.openclawDir || OPENCLAW_DIR;
  const everclawDir = options.everclawDir || EVERCLAW_DIR;

  return {
    workspace: join(openclawDir, `workspace-${agentId}`),
    xmtpIdentity: join(everclawDir, `xmtp-${agentId}`),
    registry: options.registryPath || join(everclawDir, 'buddy-registry.json'),
    peers: options.peersPath || join(everclawDir, 'xmtp', 'peers.json'),
  };
}

// ── Validation ───────────────────────────────────────────────────

/**
 * Validate that an agent exists and has exportable data.
 * @param {string} agentId
 * @returns {{ valid: boolean, paths: object, missing: string[], warnings: string[] }}
 */
export function validateAgentExists(agentId) {
  const paths = getAgentPaths(agentId);
  const missing = [];
  const warnings = [];

  if (!existsSync(paths.workspace)) {
    missing.push(`Workspace: ${paths.workspace}`);
  }

  if (!existsSync(paths.xmtpIdentity)) {
    warnings.push(`XMTP identity not found: ${paths.xmtpIdentity} (export will skip XMTP)`);
  }

  if (!existsSync(paths.registry)) {
    warnings.push('Buddy registry not found (export will skip registry entry)');
  }

  if (!existsSync(paths.peers)) {
    warnings.push('Peers file not found (export will skip peer entry)');
  }

  return {
    valid: missing.length === 0,
    paths,
    missing,
    warnings,
  };
}

// ── Registry/Peer Extraction ─────────────────────────────────────

/**
 * Extract a single agent's entry from the buddy registry.
 * @param {string} agentId
 * @param {string} [registryPath]
 * @returns {object|null}
 */
export function extractRegistryEntry(agentId, registryPath = REGISTRY_PATH) {
  if (!existsSync(registryPath)) return null;

  try {
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const buddies = registry.buddies || [];
    return buddies.find(b => b.agentId === agentId) || null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    const quarantine = registryPath + '.corrupt.' + Date.now();
    try { renameSync(registryPath, quarantine); } catch { /* best effort */ }
    throw new Error(
      `Corrupt registry at ${registryPath} (quarantined to ${quarantine}): ${err.message}. ` +
      `Refusing to silently skip.`
    );
  }
}

/**
 * Extract a single agent's peer entry from the peers file.
 * @param {string} agentId
 * @param {string} [peersPath]
 * @returns {{ address: string, entry: object }|null}
 */
export function extractPeerEntry(agentId, peersPath = PEERS_PATH) {
  if (!existsSync(peersPath)) return null;

  try {
    const peers = JSON.parse(readFileSync(peersPath, 'utf8'));
    const trusted = peers.trusted || {};
    for (const [address, entry] of Object.entries(trusted)) {
      if (entry.agentId === agentId) {
        return { address, entry };
      }
    }
    return null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    const quarantine = peersPath + '.corrupt.' + Date.now();
    try { renameSync(peersPath, quarantine); } catch { /* best effort */ }
    throw new Error(
      `Corrupt peers file at ${peersPath} (quarantined to ${quarantine}): ${err.message}. ` +
      `Refusing to silently skip.`
    );
  }
}

// ── List Agents ──────────────────────────────────────────────────

/**
 * List all agents that have exportable data.
 * Scans for workspace-{id} directories.
 * @returns {object[]}
 */
export function listExportableAgents() {
  const agents = [];

  if (!existsSync(OPENCLAW_DIR)) return agents;

  const entries = readdirSync(OPENCLAW_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('workspace-')) {
      const agentId = entry.name.replace('workspace-', '');
      if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) continue;

      const paths = getAgentPaths(agentId);
      const hasXmtp = existsSync(paths.xmtpIdentity);
      const registryEntry = extractRegistryEntry(agentId);

      agents.push({
        agentId,
        hasWorkspace: true,
        hasXmtp,
        hasRegistryEntry: registryEntry !== null,
        name: registryEntry?.name || null,
        phone: registryEntry?.phone || null,
      });
    }
  }

  return agents;
}

// ── Directory Size ───────────────────────────────────────────────

/**
 * Calculate total size of a directory in bytes.
 * @param {string} dirPath
 * @returns {number}
 */
function dirSize(dirPath) {
  if (!existsSync(dirPath)) return 0;
  let total = 0;

  function walk(dir) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          try {
            total += statSync(full).size;
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  walk(dirPath);
  return total;
}

// ── Checksums ────────────────────────────────────────────────────

/**
 * SHA-256 hash a file.
 * @param {string} filePath
 * @returns {string}
 */
function sha256File(filePath) {
  const data = readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

// ── Identity Encryption ──────────────────────────────────────────

/**
 * Recursively collect all files under a directory.
 * Returns array of { relPath, data } tuples.
 * @param {string} dir
 * @param {string} [base]
 * @returns {{ relPath: string, data: Buffer }[]}
 */
function collectIdentityFiles(dir, base = dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile()) {
      const relPath = full.slice(base.length + 1).replace(/\\/g, '/');
      results.push({ relPath, data: readFileSync(full) });
    } else if (entry.isDirectory()) {
      results.push(...collectIdentityFiles(full, base));
    }
  }
  return results;
}

/**
 * Encrypt a directory of private identity material as a single AES-256-GCM blob.
 * Packs all files into a JSON manifest { path, data(base64) }, then encrypts.
 * Key derived from passphrase via scrypt (N=16384, r=8, p=1).
 * Output: destDir/identity.enc = salt(16) + iv(12) + tag(16) + ciphertext
 * @param {string} srcDir — source identity directory
 * @param {string} destDir — destination directory for encrypted blob
 * @param {string} passphrase — encryption passphrase
 */
function encryptIdentityDir(srcDir, destDir, passphrase) {
  if (!existsSync(srcDir)) return;
  mkdirSync(destDir, { recursive: true, mode: 0o700 });

  // Collect all identity files recursively
  const files = collectIdentityFiles(srcDir);
  if (files.length === 0) return;

  // Pack into a JSON manifest
  const manifest = files.map(f => ({ path: f.relPath, data: f.data.toString('base64') }));
  const plaintext = Buffer.from(JSON.stringify(manifest), 'utf8');

  // Derive key and encrypt
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Write salt + iv + tag + ciphertext as a single blob
  const blob = Buffer.concat([salt, iv, tag, ciphertext]);
  writeFileSync(join(destDir, 'identity.enc'), blob, { mode: 0o600 });
}

// ── Export ────────────────────────────────────────────────────────

/**
 * Export a single agent's data to a tar.gz archive.
 *
 * @param {string} agentId
 * @param {string} [outputPath] — defaults to `{agentId}-export-{timestamp}.tar.gz`
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.includeIdentity=false] — include encrypted XMTP identity (requires passphrase)
 * @param {string} [options.passphrase=null] — passphrase for identity encryption (min 12 chars)
 * @param {boolean} [options.includeSocialGraph=false] — include registry and peer entries
 * @param {string} [options.openclawDir] — override for testing
 * @param {string} [options.everclawDir] — override for testing
 * @returns {object} Export result
 */
export function exportAgent(agentId, outputPath, options = {}) {
  const { dryRun = false, includeIdentity = false, passphrase = null } = options;
  // Legacy: support old --no-xmtp by treating it as includeIdentity = false
  if (options.noXmtp === true) { /* keep false */ }
  const paths = getAgentPaths(agentId, {
    openclawDir: options.openclawDir,
    everclawDir: options.everclawDir,
    registryPath: options.registryPath,
    peersPath: options.peersPath,
  });

  const workspacePath = paths.workspace;
  const xmtpPath = paths.xmtpIdentity;
  const registryPath = paths.registry;
  const peersPath = paths.peers;

  // Check workspace exists (required)
  if (!existsSync(workspacePath)) {
    throw new Error(`Agent workspace not found: ${workspacePath}`);
  }

  // Build export manifest
  const components = [];
  const warnings = [];

  // Workspace (always)
  const wsSize = dirSize(workspacePath);
  components.push({ name: 'workspace', path: workspacePath, archivePath: 'workspace', size: wsSize });

  // XMTP identity (opt-in, encrypted)
  if (includeIdentity && existsSync(xmtpPath)) {
    const xmtpSize = dirSize(xmtpPath);
    components.push({ name: 'xmtp-identity', path: xmtpPath, archivePath: 'xmtp-identity', size: xmtpSize });
  }

  // Registry entry (social graph — opt-in)
  const registryEntry = extractRegistryEntry(agentId, registryPath);
  if (options.includeSocialGraph && registryEntry) {
    components.push({ name: 'registry-entry', data: registryEntry });
  } else if (options.includeSocialGraph) {
    warnings.push('No buddy registry entry found — skipping');
  }

  // Peer entry (social graph — opt-in)
  const peerEntry = extractPeerEntry(agentId, peersPath);
  if (options.includeSocialGraph && peerEntry) {
    components.push({ name: 'peer-entry', data: peerEntry });
  } else if (options.includeSocialGraph) {
    warnings.push('No peer entry found — skipping');
  }

  const totalSize = components.reduce((sum, c) => sum + (c.size || 0), 0);

  // Safety limit
  if (totalSize > MAX_ARCHIVE_BYTES) {
    throw new Error(`Export would be ${(totalSize / 1024 / 1024).toFixed(1)} MB — exceeds ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB limit`);
  }

  // Generate timestamp for default filename
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const defaultOutput = `${agentId}-export-${ts}.tar.gz`;
  const finalOutput = outputPath || defaultOutput;

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      agentId,
      output: resolve(finalOutput),
      components: components.map(c => ({
        name: c.name,
        size: c.size || (c.data ? JSON.stringify(c.data).length : 0),
      })),
      totalSize,
      warnings,
    };
  }

  // Create staging directory
  const stagingDir = join(tmpdir(), `buddy-export-${randomUUID()}`);
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  try {
    // Copy workspace
    const wsDest = join(stagingDir, 'workspace');
    cpSync(workspacePath, wsDest, { recursive: true });

    // Identity is now OPT-IN and must be encrypted
    if (includeIdentity) {
      if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 12) {
        throw new Error(
          'Refusing to export private identity material without a strong passphrase ' +
          '(--passphrase, min 12 chars). Use --include-identity only when you intend to move keys.'
        );
      }
      if (!existsSync(xmtpPath)) {
        throw new Error(`--include-identity specified but identity path does not exist: ${xmtpPath}`);
      }

      console.error(
        'WARNING: Exporting private XMTP identity material. ' +
        'Anyone who obtains this archive and the passphrase owns the agent identity. ' +
        'Store and transmit with extreme care.'
      );

      const xmtpDest = join(stagingDir, 'xmtp-identity');
      // Encrypt the identity directory contents using AES-256-GCM
      encryptIdentityDir(xmtpPath, xmtpDest, passphrase);
    }

    // Social graph (registry + peers) — gate it or exclude by default
    if (options.includeSocialGraph && registryEntry) {
      writeFileSync(join(stagingDir, 'registry-entry.json'), JSON.stringify(registryEntry, null, 2));
    }

    // Same for peer-entry.json
    if (options.includeSocialGraph && peerEntry) {
      writeFileSync(join(stagingDir, 'peer-entry.json'), JSON.stringify(peerEntry, null, 2));
    }

    // Write manifest
    const manifest = {
      version: MANIFEST_VERSION,
      agentId,
      exportedAt: now.toISOString(),
      components: components.map(c => c.name),
      totalSize,
      // checksum verified externally via expectedChecksum on import
    };
    writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Create tar.gz
    const absOutput = resolve(finalOutput);
    const parentDir = dirname(absOutput);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    execFileSync('tar', ['-czf', absOutput, '-C', stagingDir, '.'], {
      stdio: 'pipe',
    });

    const checksum = sha256File(absOutput);

    return {
      success: true,
      dryRun: false,
      agentId,
      output: absOutput,
      checksum,
      components: components.map(c => c.name),
      totalSize,
      archiveSize: statSync(absOutput).size,
      warnings,
    };
  } finally {
    // Clean up staging
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── Import ───────────────────────────────────────────────────────

/**
 * Import a buddy bot from an archive.
 *
 * @param {string} archivePath — path to .tar.gz archive
 * @param {object} [options]
 * @param {boolean} [options.force=false] — overwrite existing data
 * @param {boolean} [options.dryRun=false]
 * @param {string} [options.openclawDir]
 * @param {string} [options.everclawDir]
 * @returns {object} Import result
 */
export function importAgent(archivePath, options = {}) {
  const { force = false, dryRun = false, expectedChecksum } = options;
  const openclawDir = options.openclawDir || OPENCLAW_DIR;
  const everclawDir = options.everclawDir || EVERCLAW_DIR;
  const registryPath = options.registryPath || join(everclawDir, 'buddy-registry.json');
  const peersPath = options.peersPath || join(everclawDir, 'xmtp', 'peers.json');

  if (!archivePath || !existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath}`);
  }

  // Safety check: archive size
  const archiveSize = statSync(archivePath).size;
  if (archiveSize > MAX_ARCHIVE_BYTES) {
    throw new Error(`Archive is ${(archiveSize / 1024 / 1024).toFixed(1)} MB — exceeds ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB safety limit`);
  }

  // Verify archive checksum BEFORE any extraction or manifest parsing
  if (expectedChecksum) {
    const actual = sha256File(resolve(archivePath));
    if (actual !== expectedChecksum) {
      throw new Error(`Checksum mismatch. Expected ${expectedChecksum}, got ${actual}`);
    }
  }

  // Extract to temp directory
  const extractDir = join(tmpdir(), `buddy-import-${randomUUID()}`);
  mkdirSync(extractDir, { recursive: true, mode: 0o700 });

  try {
    // ── SECURITY: Validate tar contents BEFORE extraction ──
    const tarPath = resolve(archivePath);
    const tarList = execFileSync('tar', ['-tzf', tarPath], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    }).split('\n');
    for (const entry of tarList) {
      if (!entry) continue;
      const normalized = entry.replace(/\\/g, '/');
      if (normalized.startsWith('/') ||
          normalized.startsWith('../') ||
          normalized.includes('/../') ||
          normalized === '..') {
        throw new Error(`Unsafe path in archive: ${entry}`);
      }
    }

    try {
      execFileSync('tar', ['-xzf', tarPath, '-C', extractDir], {
        stdio: 'pipe',
      });
    } catch (err) {
      throw new Error(`Failed to extract archive: ${err.message}`);
    }

    // Post-extraction defense-in-depth
    const extracted = execFileSync('find', [extractDir, '-type', 'f', '-o', '-type', 'l'], {
      encoding: 'utf8',
    })
      .trim().split('\n').filter(Boolean);
    for (const entry of extracted) {
      const rel = entry.slice(extractDir.length + 1);
      if (rel.startsWith('/') || rel.startsWith('..')) {
        throw new Error(`Unsafe extracted path: ${rel}`);
      }
    }

    // Check symlink targets don't escape the extract directory
    const symlinks = execFileSync('find', [extractDir, '-type', 'l'], {
      encoding: 'utf8',
    })
      .trim().split('\n').filter(Boolean);
    for (const link of symlinks) {
      try {
        const target = readlinkSync(link);
        const resolved = resolve(dirname(link), target);
        if (!(resolved === extractDir || resolved.startsWith(extractDir + sep))) {
          throw new Error(`Symlink escapes archive boundary: ${link} -> ${target}`);
        }
      } catch (err) {
        if (err.message.includes('escapes archive')) throw err;
        // Broken symlink — remove it
        try { rmSync(link, { force: true }); } catch { /* best effort */ }
      }
    }

    // Read manifest
    const manifestPath = join(extractDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error('Invalid archive: manifest.json not found');
    }

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new Error('Invalid archive: corrupt manifest.json');
    }

    if (manifest.version !== MANIFEST_VERSION) {
      throw new Error(`Unsupported manifest version: ${manifest.version}`);
    }
    if (!manifest.agentId || typeof manifest.agentId !== 'string') {
      throw new Error('Invalid manifest: agentId missing');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(manifest.agentId)) {
      throw new Error('Invalid manifest: agentId contains invalid characters');
    }

    const agentId = manifest.agentId;
    const paths = getAgentPaths(agentId, {
      openclawDir,
      everclawDir,
      registryPath,
      peersPath,
    });
    const targetWorkspace = paths.workspace;
    const targetXmtp = paths.xmtpIdentity;
    const regPath = paths.registry;
    const peerPath = paths.peers;

    // Conflict detection
    const conflicts = [];
    if (existsSync(targetWorkspace)) conflicts.push(`Workspace: ${targetWorkspace}`);
    if (existsSync(targetXmtp) && existsSync(join(extractDir, 'xmtp-identity'))) {
      conflicts.push(`XMTP identity: ${targetXmtp}`);
    }

    if (conflicts.length > 0 && !force) {
      return {
        success: false,
        agentId,
        conflicts,
        error: 'Existing data would be overwritten. Use --force to overwrite.',
      };
    }

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        agentId,
        components: manifest.components || [],
        conflicts,
        wouldOverwrite: conflicts.length > 0,
      };
    }

    const restored = [];

    // Restore workspace
    const srcWorkspace = join(extractDir, 'workspace');
    if (existsSync(srcWorkspace)) {
      if (existsSync(targetWorkspace) && force) {
        rmSync(targetWorkspace, { recursive: true, force: true });
      }
      mkdirSync(dirname(targetWorkspace), { recursive: true });
      cpSync(srcWorkspace, targetWorkspace, { recursive: true });
      restored.push('workspace');
    }

    // Restore XMTP identity
    const srcXmtp = join(extractDir, 'xmtp-identity');
    if (existsSync(srcXmtp)) {
      if (existsSync(targetXmtp) && force) {
        rmSync(targetXmtp, { recursive: true, force: true });
      }
      mkdirSync(dirname(targetXmtp), { recursive: true });
      cpSync(srcXmtp, targetXmtp, { recursive: true });
      restored.push('xmtp-identity');
    }

    // Restore registry entry
    const srcRegistry = join(extractDir, 'registry-entry.json');
    if (existsSync(srcRegistry)) {
      try {
        const entry = JSON.parse(readFileSync(srcRegistry, 'utf8'));
        mergeRegistryEntry(entry, regPath);
        restored.push('registry-entry');
      } catch (err) {
        // Non-fatal
        restored.push(`registry-entry (failed: ${err.message})`);
      }
    }

    // Restore peer entry
    const srcPeer = join(extractDir, 'peer-entry.json');
    if (existsSync(srcPeer)) {
      try {
        const peerData = JSON.parse(readFileSync(srcPeer, 'utf8'));
        mergePeerEntry(peerData, peerPath);
        restored.push('peer-entry');
      } catch (err) {
        restored.push(`peer-entry (failed: ${err.message})`);
      }
    }

    return {
      success: true,
      dryRun: false,
      agentId,
      restored,
      conflicts: conflicts.length > 0 ? conflicts : [],
      forced: conflicts.length > 0 && force,
    };
  } finally {
    try { rmSync(extractDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── Registry/Peer Merge ──────────────────────────────────────────

/**
 * Merge a registry entry into the buddy registry (upsert by agentId).
 * @param {object} entry
 * @param {string} [registryPath]
 */
function mergeRegistryEntry(entry, registryPath = REGISTRY_PATH) {
  let registry = { version: '1.0', buddies: [] };
  if (existsSync(registryPath)) {
    try {
      registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    } catch { /* start fresh */ }
  }

  if (!Array.isArray(registry.buddies)) {
    registry.buddies = [];
  }

  // Upsert
  const idx = registry.buddies.findIndex(b => b.agentId === entry.agentId);
  if (idx >= 0) {
    registry.buddies[idx] = entry;
  } else {
    registry.buddies.push(entry);
  }

  mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
  const tmpPath = registryPath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2));
  renameSync(tmpPath, registryPath);
}

/**
 * Merge a peer entry into the peers file (upsert by address).
 * @param {{ address: string, entry: object }} peerData
 * @param {string} [peersPath]
 */
function mergePeerEntry(peerData, peersPath = PEERS_PATH) {
  if (!peerData || !peerData.address || !peerData.entry) return;

  let peers = { trusted: {} };
  if (existsSync(peersPath)) {
    try {
      peers = JSON.parse(readFileSync(peersPath, 'utf8'));
    } catch { /* start fresh */ }
  }

  if (!peers.trusted || typeof peers.trusted !== 'object') {
    peers.trusted = {};
  }

  peers.trusted[peerData.address] = peerData.entry;

  mkdirSync(dirname(peersPath), { recursive: true, mode: 0o700 });
  const tmpPath = peersPath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(peers, null, 2));
  renameSync(tmpPath, peersPath);
}

// ── CLI ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    agentId: null,
    output: null,
    importPath: null,
    checksum: null,
    list: false,
    dryRun: false,
    force: false,
    noXmtp: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        console.error(`❌ ${arg} requires a value`);
        process.exit(1);
      }
      return argv[++i];
    };

    switch (arg) {
      case '--agent-id':  args.agentId = takeValue(); break;
      case '--output':
      case '-o':          args.output = takeValue(); break;
      case '--import':    args.importPath = takeValue(); break;
      case '--list':      args.list = true; break;
      case '--dry-run':   args.dryRun = true; break;
      case '--force':     args.force = true; break;
      case '--checksum':  args.checksum = takeValue(); break;
      case '--no-xmtp':   args.noXmtp = true; break;
      case '--help':
      case '-h':          args.help = true; break;
    }
  }
  return args;
}

function showHelp() {
  console.log(`
buddy-export — Scoped Agent Export & Import

Usage:
  node buddy-export.mjs --agent-id <id> [--output <path>] [--dry-run] [--no-xmtp]
  node buddy-export.mjs --import <archive.tar.gz> [--force] [--checksum <sha256>] [--dry-run]
  node buddy-export.mjs --list
  node buddy-export.mjs --help

Export flags:
  --agent-id <id>   Agent to export (required for export)
  --output <path>   Output file (default: {agentId}-export-{timestamp}.tar.gz)
  --no-xmtp         Skip XMTP identity (workspace only)
  --dry-run         Show what would be exported/imported

Import flags:
  --import <path>   Archive to import
  --force           Overwrite existing data on conflict
  --checksum <hex>  Verify SHA-256 checksum before import

Other:
  --list            List exportable agents

Examples:
  # Export alice's data
  node buddy-export.mjs --agent-id alice

  # Dry run — see what would be exported
  node buddy-export.mjs --agent-id alice --dry-run

  # Import on another host
  node buddy-export.mjs --import alice-export-202604190400.tar.gz

  # List all agents
  node buddy-export.mjs --list
`);
}

function cmdList() {
  const agents = listExportableAgents();
  if (agents.length === 0) {
    console.log('No exportable agents found.');
    return;
  }

  console.log(`📋 Exportable agents (${agents.length}):\n`);
  for (const a of agents) {
    const name = a.name ? ` (${a.name})` : '';
    const xmtp = a.hasXmtp ? '✅' : '❌';
    const reg = a.hasRegistryEntry ? '✅' : '❌';
    console.log(`  ${a.agentId}${name}`);
    console.log(`    Workspace: ✅  XMTP: ${xmtp}  Registry: ${reg}`);
    if (a.phone) console.log(`    Phone: ${a.phone}`);
    console.log('');
  }
}

function cmdExport(args) {
  try {
    const result = exportAgent(args.agentId, args.output, {
      dryRun: args.dryRun,
      noXmtp: args.noXmtp,
    });

    if (result.dryRun) {
      console.log('\n📦 Dry Run — What would be exported:\n');
      console.log(`  Agent: ${result.agentId}`);
      console.log(`  Output: ${result.output}`);
      console.log(`  Components:`);
      for (const c of result.components) {
        const size = c.size > 0 ? ` (${(c.size / 1024).toFixed(1)} KB)` : '';
        console.log(`    ✅ ${c.name}${size}`);
      }
      console.log(`  Total: ${(result.totalSize / 1024).toFixed(1)} KB`);
      if (result.warnings.length > 0) {
        console.log(`  Warnings:`);
        for (const w of result.warnings) {
          console.log(`    ⚠️  ${w}`);
        }
      }
    } else {
      console.log(`✅ Exported ${result.agentId} → ${result.output}`);
      console.log(`   Components: ${result.components.join(', ')}`);
      console.log(`   Archive size: ${(result.archiveSize / 1024).toFixed(1)} KB`);
      console.log(`   SHA-256: ${result.checksum}`);
      if (result.warnings.length > 0) {
        for (const w of result.warnings) {
          console.log(`   ⚠️  ${w}`);
        }
      }
    }
  } catch (err) {
    console.error(`❌ Export failed: ${err.message}`);
    process.exit(1);
  }
}

function cmdImport(args) {
  try {
    const result = importAgent(args.importPath, {
      force: args.force,
      dryRun: args.dryRun,
      expectedChecksum: args.checksum,
    });

    if (!result.success && result.conflicts) {
      console.error(`❌ Import blocked — existing data would be overwritten:`);
      for (const c of result.conflicts) {
        console.error(`   ${c}`);
      }
      console.error(`\nUse --force to overwrite.`);
      process.exit(1);
    }

    if (result.dryRun) {
      console.log('\n📦 Dry Run — What would be imported:\n');
      console.log(`  Agent: ${result.agentId}`);
      console.log(`  Components: ${result.components.join(', ')}`);
      if (result.conflicts.length > 0) {
        console.log(`  Would overwrite:`);
        for (const c of result.conflicts) {
          console.log(`    ⚠️  ${c}`);
        }
      }
    } else {
      console.log(`✅ Imported ${result.agentId}`);
      console.log(`   Restored: ${result.restored.join(', ')}`);
      if (result.forced) {
        console.log(`   ⚠️  Overwrote existing data (--force)`);
      }
    }
  } catch (err) {
    console.error(`❌ Import failed: ${err.message}`);
    process.exit(1);
  }
}

// ── Entry Point ──────────────────────────────────────────────────

const IS_CLI = process.argv[1] && (
  process.argv[1].endsWith('buddy-export.mjs') ||
  process.argv[1].endsWith('buddy-export')
);

if (IS_CLI) {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
  } else if (args.list) {
    cmdList();
  } else if (args.importPath) {
    cmdImport(args);
  } else if (args.agentId) {
    cmdExport(args);
  } else {
    showHelp();
  }
}
