#!/usr/bin/env node
/**
 * migrate-serve.test.mjs — Tests for the source-served migration flow (Option D)
 *
 * Tests:
 * - generateInstallScript() output shape, embedded values, no passphrase leak
 * - bash syntax valid on generated script
 * - detectLanIp() returns a non-empty string
 */

import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { generateInstallScript, detectLanIp } from './migrate-serve.mjs';

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => passed++).catch(e => { failed++; failures.push({ name, err: e.message }); });
    passed++;
  } catch (e) {
    failed++; failures.push({ name, err: e.message });
  }
}

// ── generateInstallScript ───────────────────────────────────────

const sampleScript = generateInstallScript({
  serverUrl: 'http://192.168.1.42:18790',
  token: 'a]b1c2d3-e4f5-6a7b-8c9d-0e1f2g3h4i5j',
  checksumHex: 'a'.repeat(64),
  bundleName: 'migrate-bundle-202608311430.tar.gz.enc',
  openclawPin: '2026.7.1-2',
  bundleSize: 52428800,  // 50 MB
  scriptChecksums: {
    'migrate-import.mjs': 'b'.repeat(64),
    'migrate-export.mjs': 'c'.repeat(64),
    'paths.mjs': 'd'.repeat(64),
  },
});

test('script contains embedded server URL', () => {
  if (!sampleScript.includes('http://192.168.1.42:18790')) throw new Error('server URL missing');
});

test('script contains embedded token', () => {
  if (!sampleScript.includes('a]b1c2d3-e4f5-6a7b-8c9d-0e1f2g3h4i5j')) throw new Error('token missing');
});

test('script contains embedded checksum', () => {
  if (!sampleScript.includes('a'.repeat(64))) throw new Error('checksum missing');
});

test('script contains embedded bundle name', () => {
  if (!sampleScript.includes('migrate-bundle-202608311430.tar.gz.enc')) throw new Error('bundle name missing');
});

test('script uses token-gated /install/<token> path (Grok R1 S-5 fix)', () => {
  // The install script itself is fetched from /install/<token>, not bare /install
  // (the token gates access to the script too, not just the bundle)
  // This is verified by checking the agent-download-server test, not the generated script.
  // The generated script doesn't fetch itself from /install — the user's curl does.
  // Instead verify the scripts endpoints are token-gated:
  if (!sampleScript.includes('?token=$TOKEN')) throw new Error('scripts endpoints missing token query param');
});

test('script contains pinned openclaw version (never @latest)', () => {
  // Pin lands as shell var OPENCLAW_PIN='<version>' (single-quoted, injection-safe)
  // + npm install openclaw@$OPENCLAW_PIN
  if (!sampleScript.includes("OPENCLAW_PIN='2026.7.1-2'")) throw new Error('pinned version missing');
  if (sampleScript.includes('openclaw@latest')) throw new Error('script installs @latest — forbidden');
  if (!sampleScript.includes('openclaw@$OPENCLAW_PIN')) throw new Error('install command does not use the pin');
});

test('embedded values use single quotes (injection-safe, Grok R1 S-2)', () => {
  // All five embedded constants must be single-quoted so $ ` " are literal.
  for (const line of sampleScript.split('\n')) {
    const m = line.match(/^(BUNDLE_SHA256|SERVER_URL|TOKEN|BUNDLE_NAME|OPENCLAW_PIN)="([^"]*)"$/);
    if (m) throw new Error(`double-quoted embedded constant: ${m[0]}`);
  }
  if (!sampleScript.includes("SERVER_URL='http://192.168.1.42:18790'")) throw new Error('single-quote embedding missing');
});

test('single quote in any embedded value is refused (injection guard)', () => {
  let threw = false;
  try {
    generateInstallScript({
      serverUrl: "http://192.168.1.42'; rm -rf /;#",
      token: 't', checksumHex: 'a'.repeat(64),
      bundleName: 'b.tar.gz.enc', openclawPin: '2026.7.1-2', bundleSize: 1,
      scriptChecksums: { 'migrate-import.mjs': 'x'.repeat(64) },
    });
  } catch { threw = true; }
  if (!threw) throw new Error('generateInstallScript accepted a single-quoted value — injection not blocked');
});

test('script includes helper-script checksum verification (Grok R3 security fix)', () => {
  if (!sampleScript.includes("check_script migrate-import.mjs '" + 'b'.repeat(64) + "'")) throw new Error('migrate-import checksum not embedded');
  if (!sampleScript.includes("check_script migrate-export.mjs '" + 'c'.repeat(64) + "'")) throw new Error('migrate-export checksum not embedded');
  if (!sampleScript.includes("check_script paths.mjs '" + 'd'.repeat(64) + "'")) throw new Error('paths.mjs checksum not embedded');
  if (!sampleScript.includes('hash_of()')) throw new Error('hash_of helper function missing');
});

test('linux install steps use sudo (rootless-user fix)', () => {
  if (!sampleScript.includes('| sudo bash -')) throw new Error('NodeSource setup not run via sudo');
  if (!sampleScript.includes('sudo apt-get install -y nodejs')) throw new Error('apt-get install missing sudo');
  if (!sampleScript.includes('sudo dnf install -y nodejs')) throw new Error('dnf install missing sudo');
  if (!sampleScript.includes('sudo npm install -g "openclaw@$OPENCLAW_PIN"')) throw new Error('npm global install missing sudo attempt');
});

test('import scripts download BEFORE bundle (server exits after bundle GET)', () => {
  const scriptsIdx = sampleScript.indexOf('/scripts/migrate-import.mjs');
  const bundleIdx = sampleScript.indexOf('$SERVER_URL/$TOKEN/$BUNDLE_NAME');
  if (scriptsIdx === -1 || bundleIdx === -1) throw new Error('expected download steps missing');
  if (scriptsIdx > bundleIdx) throw new Error('scripts fetched after bundle — server already shut down, import would fail');
  // Exactly one occurrence of the import-script fetch (no duplicate step)
  const count = sampleScript.split('/scripts/migrate-import.mjs').length - 1;
  if (count !== 1) throw new Error(`import script fetched ${count} times — expected exactly 1`);
});

test('script does NOT contain passphrase', () => {
  // Passphrase is prompted on target via /dev/tty; never embedded.
  // A literal assignment like PASSPHRASE="actual-secret" is a leak;
  // var refs like "..."$PASSPHRASE" are fine.
  const leak = sampleScript.match(/PASSPHRASE=["'][^$"'][^"']*["']/);
  if (leak) throw new Error(`passphrase value embedded: ${leak[0]}`);
});

test('script includes NodeSource for Linux', () => {
  if (!sampleScript.includes('deb.nodesource.com')) throw new Error('NodeSource missing');
});

test('script includes auto-start gateway', () => {
  if (!sampleScript.includes('openclaw gateway start')) throw new Error('gateway auto-start missing');
});

test('script includes checksum verification step', () => {
  if (!sampleScript.includes('sha256sum') && !sampleScript.includes('shasum')) throw new Error('checksum verification missing');
});

test('script includes cleanup trap', () => {
  if (!sampleScript.includes("trap 'rm -rf")) throw new Error('cleanup trap missing');
});

// ── bash syntax check ───────────────────────────────────────────

test('generated script passes bash -n', () => {
  const dir = join(tmpdir(), `mig-serve-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, 'install.sh');
  writeFileSync(scriptPath, sampleScript, { mode: 0o644 });
  try {
    execFileSync('bash', ['-n', scriptPath], { timeout: 5000, stdio: 'pipe' });
  } catch (e) {
    throw new Error(`bash -n failed: ${e.stderr?.toString()?.slice(0, 200) || e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── detectLanIp ─────────────────────────────────────────────────

test('detectLanIp returns non-empty string', () => {
  const ip = detectLanIp();
  if (!ip || typeof ip !== 'string') throw new Error(`bad IP: ${ip}`);
  // Must be an IPv4 or 127.0.0.1 fallback
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`not IPv4: ${ip}`);
});

// ── summary ──────────────────────────────────────────────────────

process.on('exit', () => {
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  FAIL: ${f.name} — ${f.err}`);
  process.exit(1);
}
});
