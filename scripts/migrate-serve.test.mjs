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

test('script contains pinned openclaw version (never @latest)', () => {
  // Pin lands as shell var OPENCLAW_PIN="<version>" + npm install openclaw@$OPENCLAW_PIN
  if (!sampleScript.includes('OPENCLAW_PIN="2026.7.1-2"')) throw new Error('pinned version missing');
  if (sampleScript.includes('openclaw@latest')) throw new Error('script installs @latest — forbidden');
  if (!sampleScript.includes('openclaw@$OPENCLAW_PIN')) throw new Error('install command does not use the pin');
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
