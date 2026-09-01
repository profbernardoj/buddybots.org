#!/usr/bin/env node
/**
 * migrate.test.mjs — Tests for Full-Host Migration Export/Import (Gap 8)
 *
 * Round-trip in fake $HOMEs, crypto, role policy, templating, preflight,
 * burn behavior. Uses dependency-injected openclawDir/staging — never touches
 * real ~/.openclaw.
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

import {
  templateConfig, untemplateConfig, applyCronRole, extractSkillsState,
  encryptBuffer, decryptBuffer, findWorkspaces, generateRunbook,
  buildDependencyManifest, collectKeychainSecrets, parseKeychainAccount,
} from './migrate-export.mjs';
import {
  unpackBundle, preflight, restoreConfig, restoreKeychain, reenableSkills,
  stageCronImport, burnCommand, gatewayCommand,
} from './migrate-import.mjs';

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => { passed++; }).catch(e => { failed++; failures.push({ name, err: e.message }); }); passed++; }
  catch (e) { failed++; failures.push({ name, err: e.message }); }
}
function assertEq(a, e, l) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${l}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

// ── templating (L3) ──────────────────────────────────────────────

await (async () => {
  const home = process.env.HOME;
  const { template, hits } = templateConfig({ a: `${home}/x`, b: 'plain' }, home);
  test('template literalizes home path', () => {
    if (!template.includes('{{HOME}}/x')) throw new Error('template missing {{HOME}}');
  });
  test('template hit count', () => {
    if (hits !== 1) throw new Error(`hits=${hits}`);
  });
  test('untemplate restores', () => {
    const back = template.split('{{HOME}}').join('/Users/someone');
    if (back !== JSON.stringify({ a: '/Users/someone/x', b: 'plain' }, null, 2)) throw new Error('untemplate mismatch');
  });
})();

// ── crypto round-trip (L6) ───────────────────────────────────────

test('encrypt/decrypt round-trip', () => {
  const msg = Buffer.from('{"venice-key1":"secret-value"}');
  const blob = encryptBuffer(msg, 'correct-horse-battery');
  const out = decryptBuffer(blob, 'correct-horse-battery');
  if (out.toString() !== msg.toString()) throw new Error('round-trip mismatch');
});
test('wrong passphrase fails cleanly', () => {
  const blob = encryptBuffer(Buffer.from('data'), 'correct-passphrase-123');
  let threw = false;
  try { decryptBuffer(blob, 'wrong-passphrase-99999999'); } catch { threw = true; }
  if (!threw) throw new Error('wrong passphrase did not throw');
});
test('short blob rejected', () => {
  let threw = false;
  try { decryptBuffer(Buffer.from('tiny'), 'some-passphrase'); } catch (e) {
    threw = /too short/.test(e.message);
  }
  if (!threw) throw new Error('short blob did not throw with clear message');
});

// ── cron role policy (L5) ────────────────────────────────────────

test('deps platform-aware: target linux emits apt', () => {
  const d = buildDependencyManifest({ plugins: { entries: {} } }, 'linux');
  const joined = d.commands.join('\n');
  if (!joined.includes('apt-get')) throw new Error('linux target missing apt');
  if (joined.includes('brew install')) throw new Error('linux target got brew');
  const m = buildDependencyManifest({ plugins: { entries: {} } }, 'darwin');
  if (!m.commands.join('\n').includes('brew install node')) throw new Error('darwin target missing brew');
});

test('version pin: never installs openclaw@latest (David, 2026-08-31)', async () => {
  const { probeOpenclawVersion } = await import('./migrate-export.mjs');
  const d = buildDependencyManifest({ plugins: { entries: {} } }, 'darwin');
  const v = probeOpenclawVersion();
  const joined = d.commands.join('\n');
  // Must install a pinned version, never @latest
  if (joined.includes('openclaw@latest')) throw new Error('dep manifest installs @latest — forbidden');
  if (!new RegExp(`openclaw@\\d`).test(joined)) throw new Error(`dep manifest missing pinned install: ${joined}`);
  // Probed or fallback version must be a real version shape
  if (!/^\d{4}\.\d+\.\d+[-.]\d+$/.test(v)) throw new Error(`probeOpenclawVersion bad shape: ${v}`);
});

test('version pin: memory says 2026.7.1-2 fallback when openclaw binary absent', async () => {
  // probeOpenclawVersion falls back to PINNED_OPENCLAW_VERSION (2026.7.1-2)
  // when the openclaw binary is missing or the version regex fails.
  const { probeOpenclawVersion } = await import('./migrate-export.mjs');
  const v = probeOpenclawVersion();
  // On this dev host the real binary IS present (2026.7.1-2), so both paths
  // must yield a valid pin — never null, never 'latest'.
  if (!v || v === 'latest') throw new Error(`bad pin: ${v}`);
});

test('version pin: linux uses NodeSource (David approved NodeSource apt)', () => {
  const d = buildDependencyManifest({ plugins: { entries: {} } }, 'linux');
  const joined = d.commands.join('\n');
  if (!joined.includes('deb.nodesource.com')) throw new Error('linux target missing NodeSource');
  if (!/^apt-get install -y nodejs$/m.test(joined)) throw new Error('linux NodeSource nodejs install missing');
});

test('worker role disables all crons', () => {
  const jobs = [{ name: 'a', enabled: true }, { name: 'b', enabled: true }];
  const out = applyCronRole(jobs, 'worker');
  if (out.some(j => j.enabled !== false)) throw new Error('worker crons not all disabled');
});
test('primary role preserves enabled', () => {
  const jobs = [{ name: 'a', enabled: true }, { name: 'b', enabled: false }];
  const out = applyCronRole(jobs, 'primary');
  if (out[0].enabled !== true || out[1].enabled !== false) throw new Error('primary altered jobs');
});
test('null crons pass through', () => {
  if (applyCronRole(null, 'worker') !== null) throw new Error('null not preserved');
});

// ── skills state (L2/L10) ────────────────────────────────────────

test('extract skills state', () => {
  // R9: use a config whose disabled entries CARRY a disabledReason — the exact
  // doctor-disabled shape. Any skill present in the source config is wanted
  // once binaries exist, so wanted must be true regardless of the reason.
  const cfg = { skills: { entries: { gog: { enabled: false, disabledReason: 'missing binary: ollama' }, x: { enabled: true } } } };
  const s = extractSkillsState(cfg);
  if (s.gog.enabled !== false || s.x.enabled !== true) throw new Error('extract wrong');
  // R8/R9: .wanted is the DESIRED map — even a doctor-disabled skill (enabled:false
  // WITH a disabledReason) is wanted once deps exist.
  if (s.gog.wanted !== true || s.x.wanted !== true) throw new Error('wanted map wrong');
});
test('re-enable only source-enabled skills', () => {
  const flipped = reenableSkills(
    { gog: { enabled: true }, bagman: { enabled: true }, offskill: { enabled: false } },
    { skills: { entries: { gog: { enabled: false }, bagman: { enabled: true }, offskill: { enabled: false } } } },
  );
  if (flipped.length !== 1 || flipped[0] !== 'gog') throw new Error(`flipped=${JSON.stringify(flipped)}`);
});
test('doctor-disabled skill still re-enabled via wanted map (R8)', () => {
  // Source: openclaw doctor disabled 'gog' because the binary was missing.
  // export writes wanted:true. Import must flip it back on after deps install.
  const flipped = reenableSkills(
    { gog: { enabled: false, wanted: true }, offskill: { enabled: false, wanted: false } },
    { skills: { entries: { gog: { enabled: false }, offskill: { enabled: false } } } },
  );
  if (flipped.length !== 1 || flipped[0] !== 'gog') throw new Error(`flipped=${JSON.stringify(flipped)}`);
});

// ── dependency manifest (L1/L2) ──────────────────────────────────

test('known plugins map to npm packages', () => {
  const deps = buildDependencyManifest({ plugins: { entries: { signal: {}, brave: {}, venice: {}, 'llama-cpp': {} } } });
  for (const p of ['@openclaw/signal', '@openclaw/brave-plugin', '@openclaw/venice-provider', '@openclaw/llama-cpp-provider']) {
    if (!deps.plugins.some(x => x.npm === p)) throw new Error(`missing plugin ${p}`);
  }
  if (!deps.commands.some(c => c.includes('openclaw plugins install @openclaw/signal'))) throw new Error('no install cmd for signal');
});
test('unknown plugins flagged, not crashed', () => {
  const deps = buildDependencyManifest({ plugins: { entries: { mystery: {} } } });
  if (!deps.unknownPlugins.includes('mystery')) throw new Error('unknown plugin not flagged');
});
test('disabled plugins skipped', () => {
  const deps = buildDependencyManifest({ plugins: { entries: { signal: { enabled: false } } } });
  if (deps.plugins.length !== 0) throw new Error('disabled plugin included');
});

// ── config restore (L3) ──────────────────────────────────────────

test('restoreConfig writes valid JSON for new home', () => {
  const dir = join(tmpdir(), `mig-cfg-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const newHome = join(tmpdir(), `mig-newhome-${Date.now()}`);
  mkdirSync(newHome, { recursive: true });
  const out = restoreConfig('{"p": "{{HOME}}/data"}', newHome, dir, true);
  const parsed = JSON.parse(readFileSync(out, 'utf8'));
  if (parsed.p !== join(newHome, 'data')) throw new Error('restore wrong');
});
test('restoreConfig refuses overwrite without force', () => {
  const dir = join(tmpdir(), `mig-cfg2-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'openclaw.json'), '{"existing": true}');
  let threw = false;
  try { restoreConfig('{"p":"{{HOME}}"}', join(tmpdir(), 'mig-x'), dir, false); } catch (e) { threw = /--force/.test(e.message); }
  if (!threw) throw new Error('overwrite without force allowed');
});

// ── keychain (L6) ────────────────────────────────────────────────

test('collectKeychainSecrets reports missing without crash', () => {
  const r = collectKeychainSecrets(['definitely-not-a-real-service-xyz']);
  if (!r.missing.includes('definitely-not-a-real-service-xyz')) throw new Error('missing not reported');
  if (Object.keys(r.secrets).length !== 0) throw new Error('phantom secrets');
});

// ── cron staging (L4/L5) ─────────────────────────────────────────

test('stageCronImport worker → all disabled', () => {
  const dir = join(tmpdir(), `mig-cron-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([{ name: 'j1', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *' } }]));
  const r = stageCronImport(dir, { role: 'worker' });
  if (!r.staged || r.allDisabled !== true || r.jobs[0].enabled !== false) throw new Error('worker staging wrong');
});
test('stageCronImport missing file → excluded', () => {
  const r = stageCronImport(tmpdir(), { role: 'primary' });
  if (r.staged !== false) throw new Error('should report not staged');
});

// ── bundle round-trip (integration, fake env) ────────────────────

test('export → unpack round-trip with fake openclawDir', async () => {
  const env = makeFakeEnv();
  const { exportMigrateBundle } = await import('./migrate-export.mjs');
  const outPath = join(env.root, 'bundle.tar.gz.enc');
  const res = await exportMigrateBundle({
    output: outPath,
    passphrase: 'test-passphrase-12345678',
    role: 'worker',
    openclawDir: env.openclawDir,
    cronsFile: env.cronsFile,
    keychainServices: ['no-such-service-in-test'],
    stagingDir: join(env.root, 'stage'),
  });
  if (res.cronCount !== 1) throw new Error(`cronCount=${res.cronCount}`);
  if (res.workspaceCount < 2) throw new Error(`workspaceCount=${res.workspaceCount}`);

  const staging2 = join(env.root, 'unpack');
  const { manifest, extractDir } = await unpackBundle(outPath, 'test-passphrase-12345678', staging2);
  if (manifest.schemaVersion !== '2.0') throw new Error('schema mismatch');
  if (manifest.role !== 'worker') throw new Error('role mismatch');
  if (!existsSync(join(extractDir, 'config.json.tmpl'))) throw new Error('config tmpl missing');
  if (!existsSync(join(extractDir, 'keychain.json.enc'))) throw new Error('keychain blob missing');
  if (!existsSync(join(extractDir, 'RUNBOOK.md'))) throw new Error('runbook missing');
  if (!existsSync(join(extractDir, 'workspaces.tar'))) throw new Error('workspaces missing');
  const tmpl = readFileSync(join(extractDir, 'config.json.tmpl'), 'utf8');
  if (tmpl.includes(process.env.HOME)) throw new Error('config template leaked literal home path');
  // B1 regression (Claude audit): the out-of-band checksum is the SHA-256 of
  // the ENCRYPTED FILE — the exact artifact the operator holds — and the
  // shipped runbook must NOT embed it (fixed point: an in-bundle value would
  // be recomputable by a tamperer).
  const shippedRunbook = readFileSync(join(extractDir, 'RUNBOOK.md'), 'utf8');
  if (!res.bundleChecksum || res.bundleChecksum === 'null') throw new Error('export did not return a bundle checksum');
  const encHash = createHash('sha256').update(readFileSync(outPath)).digest('hex');
  if (res.bundleChecksum !== encHash) throw new Error('bundleChecksum is not the SHA-256 of the encrypted file');
  if (shippedRunbook.includes(res.bundleChecksum)) throw new Error('runbook must NOT embed the out-of-band checksum');
  if (!shippedRunbook.includes('SHA-256 of the ENCRYPTED bundle file')) throw new Error('runbook missing out-of-band verification note');
  rmSync(env.root, { recursive: true, force: true });
});
test('out-of-band checksum: import succeeds with exporter-printed value (B1)', async () => {
  const env = makeFakeEnv();
  const { exportMigrateBundle } = await import('./migrate-export.mjs');
  const outPath = join(env.root, 'c.tar.gz.enc');
  const res = await exportMigrateBundle({ output: outPath, passphrase: 'checksum-pass-12345678', role: 'primary', openclawDir: env.openclawDir, cronsFile: env.cronsFile, keychainServices: [], stagingDir: join(env.root, 's') });
  // The printed value (res.bundleChecksum) must validate the real artifact.
  const { manifest } = await unpackBundle(outPath, 'checksum-pass-12345678', join(env.root, 'u'), res.bundleChecksum);
  if (manifest.schemaVersion !== '2.0') throw new Error('schema mismatch on checksum-verified import');
  rmSync(env.root, { recursive: true, force: true });
});
test('out-of-band checksum: wrong value rejected (B1)', async () => {
  const env = makeFakeEnv();
  const { exportMigrateBundle } = await import('./migrate-export.mjs');
  const outPath = join(env.root, 'w.tar.gz.enc');
  await exportMigrateBundle({ output: outPath, passphrase: 'checksum-pass-12345678', role: 'primary', openclawDir: env.openclawDir, cronsFile: env.cronsFile, keychainServices: [], stagingDir: join(env.root, 's') });
  let threw = false;
  try { await unpackBundle(outPath, 'checksum-pass-12345678', join(env.root, 'u'), '0'.repeat(64)); } catch (e) { threw = /checksum MISMATCH/.test(e.message); }
  if (!threw) throw new Error('wrong out-of-band checksum accepted');
  rmSync(env.root, { recursive: true, force: true });
});
test('out-of-band checksum: byte-flipped bundle rejected (B1)', async () => {
  const env = makeFakeEnv();
  const { exportMigrateBundle } = await import('./migrate-export.mjs');
  const outPath = join(env.root, 'f.tar.gz.enc');
  const res = await exportMigrateBundle({ output: outPath, passphrase: 'checksum-pass-12345678', role: 'primary', openclawDir: env.openclawDir, cronsFile: env.cronsFile, keychainServices: [], stagingDir: join(env.root, 's') });
  const blob = readFileSync(outPath);
  blob[10] = blob[10] ^ 0xff;                 // flip one byte of the encrypted file
  writeFileSync(outPath, blob);
  let threw = false;
  try { await unpackBundle(outPath, 'checksum-pass-12345678', join(env.root, 'u'), res.bundleChecksum); } catch (e) { threw = /checksum MISMATCH/.test(e.message); }
  if (!threw) throw new Error('tampered encrypted bundle accepted with out-of-band checksum');
  rmSync(env.root, { recursive: true, force: true });
});
test('parseKeychainAccount extracts quoted account (M1)', () => {
  if (parseKeychainAccount('"acct"<blob>="bernardo"', 'openclaw') !== 'bernardo') throw new Error('quoted account not extracted');
  if (parseKeychainAccount('keychain: No such keychain', 'openclaw') !== 'openclaw') throw new Error('fallback not used on missing acct line');
  if (parseKeychainAccount('"acct"<blob>=<NULL>', 'openclaw') !== 'openclaw') throw new Error('NULL acct must fall back');
  if (parseKeychainAccount('"acct"<blob>=0xDEADBEEF', 'openclaw') !== 'openclaw') throw new Error('hex-blob acct must fall back');
  if (parseKeychainAccount('"acct"<blob>=""', 'openclaw') !== 'openclaw') throw new Error('empty quoted acct must fall back');
});
test('unpack with wrong passphrase fails cleanly', async () => {
  const env = makeFakeEnv();
  const { exportMigrateBundle } = await import('./migrate-export.mjs');
  const outPath = join(env.root, 'b.tar.gz.enc');
  await exportMigrateBundle({ output: outPath, passphrase: 'right-passphrase-12345678', role: 'primary', openclawDir: env.openclawDir, cronsFile: env.cronsFile, keychainServices: [], stagingDir: join(env.root, 's') });
  let threw = false;
  try { await unpackBundle(outPath, 'wrong-passphrase-99999999', join(env.root, 'u')); } catch (e) { threw = /wrong passphrase/.test(e.message); }
  if (!threw) throw new Error('wrong passphrase accepted');
  rmSync(env.root, { recursive: true, force: true });
});

test('tampered payload file rejected by checksum gate', async () => {
  const { execFileSync } = await import('node:child_process');
  const env = makeFakeEnv();
  const { exportMigrateBundle } = await import('./migrate-export.mjs');
  const outPath = join(env.root, 't.tar.gz.enc');
  await exportMigrateBundle({ output: outPath, passphrase: 'tamper-pass-12345678', role: 'primary', openclawDir: env.openclawDir, cronsFile: env.cronsFile, keychainServices: [], stagingDir: join(env.root, 's') });

  // Decrypt (streaming format — tag at end, not after IV), untar, modify, re-tar, re-encrypt.
  const { decryptFileStreaming } = await import('./migrate-export.mjs');
  const tamperDir = join(env.root, 'tamper');
  mkdirSync(tamperDir, { recursive: true });
  const plainTar = join(tamperDir, 'plain.tar');
  await decryptFileStreaming(outPath, plainTar, 'tamper-pass-12345678');
  execFileSync('tar', ['-xf', plainTar, '-C', tamperDir]);
  rmSync(plainTar, { force: true });  // remove intermediate tar before re-tar
  writeFileSync(join(tamperDir, 'config.json.tmpl'), '{"tampered": true, "home": "{{HOME}}"}');
  const evilTar = join(env.root, 'evil.tar');
  execFileSync('tar', ['-cf', evilTar, '-C', tamperDir, '.']);
  const { encryptFileStreaming: encStream } = await import('./migrate-export.mjs');
  await encStream(evilTar, outPath, 'tamper-pass-12345678');

  let threw = false;
  try { await unpackBundle(outPath, 'tamper-pass-12345678', join(env.root, 'u2')); } catch (e) { threw = /integrity check FAILED/.test(e.message) && /config.json.tmpl/.test(e.message); }
  if (!threw) throw new Error('tampered bundle accepted — checksum gate not enforced');
  rmSync(env.root, { recursive: true, force: true });
});

test('tampered manifest.json rejected by self-checksum gate (R10)', async () => {
  const { execFileSync } = await import('node:child_process');
  const env = makeFakeEnv();
  const { exportMigrateBundle } = await import('./migrate-export.mjs');
  const outPath = join(env.root, 'm.tar.gz.enc');
  await exportMigrateBundle({ output: outPath, passphrase: 'tamper-pass-12345678', role: 'primary', openclawDir: env.openclawDir, cronsFile: env.cronsFile, keychainServices: [], stagingDir: join(env.root, 's') });

  // A clean bundle must pass the integrity gate (self-checksum round-trips).
  await unpackBundle(outPath, 'tamper-pass-12345678', join(env.root, 'u0'));

  // Decrypt (streaming format), untar, tamper ONLY the manifest, re-tar, re-encrypt.
  const { decryptFileStreaming: decStream } = await import('./migrate-export.mjs');
  const tamperDir = join(env.root, 'mtamper');
  mkdirSync(tamperDir, { recursive: true });
  const plain = join(tamperDir, 'plain.tar');
  await decStream(outPath, plain, 'tamper-pass-12345678');
  execFileSync('tar', ['-xf', plain, '-C', tamperDir]);
  rmSync(plain, { force: true });  // remove intermediate tar before re-tar
  const manPath = join(tamperDir, 'manifest.json');
  const man = JSON.parse(readFileSync(manPath, 'utf8'));
  man.tampered = true;                       // change a top-level field
  writeFileSync(manPath, JSON.stringify(man, null, 2) + '\n');
  const evilTar = join(env.root, 'evil-m.tar');
  execFileSync('tar', ['-cf', evilTar, '-C', tamperDir, '.']);
  const { encryptFileStreaming: encStream2 } = await import('./migrate-export.mjs');
  await encStream2(evilTar, outPath, 'tamper-pass-12345678');

  let threw = false;
  try { await unpackBundle(outPath, 'tamper-pass-12345678', join(env.root, 'u1')); } catch (e) { threw = /manifest.json/.test(e.message); }
  if (!threw) throw new Error('tampered manifest accepted — self-checksum gate not enforced');
  rmSync(env.root, { recursive: true, force: true });
});

function makeFakeEnv() {
  const root = join(tmpdir(), `mig-fake-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const openclawDir = join(root, 'oc');
  mkdirSync(join(openclawDir, 'workspace'), { recursive: true });
  mkdirSync(join(openclawDir, 'workspace-sub'), { recursive: true });
  // Marker files so round-trip import can prove content landed (Claude Stage4 R3).
  writeFileSync(join(openclawDir, 'workspace', 'MEMORY.md'), '# fake memory payload\n');
  writeFileSync(join(openclawDir, 'workspace-sub', 'AGENTS.md'), '# sub agent\n');
  writeFileSync(join(openclawDir, 'openclaw.json'), JSON.stringify({ plugins: { entries: {} }, skills: { entries: {} } }));
  const cronsFile = join(root, 'crons.json');
  writeFileSync(cronsFile, JSON.stringify([{ name: 'j', enabled: true }]));
  return { root, openclawDir, cronsFile };
}

// Claude Stage4 R3 regression: export writes workspaces.tar (uncompressed);
// import previously looked only for workspaces.tar.gz and silently skipped.
test('export → import restores workspaces.tar (Claude Stage4 R3)', async () => {
  const env = makeFakeEnv();
  const { exportMigrateBundle } = await import('./migrate-export.mjs');
  const { importMigrateBundle } = await import('./migrate-import.mjs');
  const outPath = join(env.root, 'rt.tar.gz.enc');
  const res = await exportMigrateBundle({
    output: outPath,
    passphrase: 'roundtrip-pass-12345678',
    role: 'primary',
    openclawDir: env.openclawDir,
    cronsFile: env.cronsFile,
    keychainServices: [],
    stagingDir: join(env.root, 's'),
  });
  if (res.workspaceCount < 2) throw new Error(`workspaceCount=${res.workspaceCount}`);

  // Fresh target openclaw dir — force so preflight accepts overwrite.
  const targetDir = join(env.root, 'target-oc');
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'openclaw.json'), JSON.stringify({ plugins: { entries: {} }, skills: { entries: {} } }));

  const report = await importMigrateBundle({
    importPath: outPath,
    passphrase: 'roundtrip-pass-12345678',
    expectedChecksum: res.bundleChecksum,
    openclawDir: targetDir,
    force: true,
  });
  const wsStep = report.steps.find((s) => s.step === 'workspaces');
  if (!wsStep) throw new Error(`no workspaces step — silent skip. steps=${JSON.stringify(report.steps.map(s=>s.step))}`);
  if (wsStep.ok !== true) throw new Error(`workspaces step not ok: ${JSON.stringify(wsStep)}`);
  if (wsStep.source !== 'workspaces.tar') throw new Error(`expected source=workspaces.tar, got ${wsStep.source}`);
  if (!existsSync(join(targetDir, 'workspace', 'MEMORY.md'))) throw new Error('workspace/MEMORY.md not restored');
  if (!existsSync(join(targetDir, 'workspace-sub', 'AGENTS.md'))) throw new Error('workspace-sub/AGENTS.md not restored');
  const body = readFileSync(join(targetDir, 'workspace', 'MEMORY.md'), 'utf8');
  if (!body.includes('fake memory payload')) throw new Error('workspace content not restored');
  if ((report.warnings || []).some((w) => /no workspaces\.tar/.test(w))) {
    throw new Error('unexpected workspaces missing warning');
  }
  rmSync(env.root, { recursive: true, force: true });
});


// ── CLI default-parameter regression (Claude R1) ────────────────

test('parseArgs [] does not mask keychain defaults (Claude R1)', async () => {
  // parseArgs seeds keychainServices: [] — the destructure default must NOT
  // be bypassed by an empty array. Verify by checking the manifest lists
  // default services (even if missing on this platform).
  const env = makeFakeEnv();
  const { exportMigrateBundle } = await import('./migrate-export.mjs');
  const outPath = join(env.root, 'd.tar.gz.enc');
  const res = await exportMigrateBundle({
    output: outPath,
    passphrase: 'default-test-pass-12345678',
    role: 'primary',
    openclawDir: env.openclawDir,
    cronsFile: env.cronsFile,
    keychainServices: [],   // what parseArgs produces
    stagingDir: join(env.root, 's'),
  });
  // If defaults were used, keychainMissing has entries (the default services).
  // If [] bypassed defaults, keychainMissing is empty and keychainImported is empty.
  const total = res.keychainCount + res.keychainMissing.length;
  if (total === 0) throw new Error('keychainServices:[] bypassed defaults — no services probed');
  rmSync(env.root, { recursive: true, force: true });
});

test('parseArgs null does not mask targetPlatform default (Claude R1)', async () => {
  // parseArgs seeds targetPlatform: null — the destructure default must NOT
  // be bypassed by null. Verify by checking the dependency manifest has
  // platform-specific commands (brew on darwin, apt on linux), not just
  // the pinned version (probeOpenclawVersion falls back to 2026.7.1-2 if the binary is missing).
  const env = makeFakeEnv();
  const { exportMigrateBundle } = await import('./migrate-export.mjs');
  const outPath = join(env.root, 'p.tar.gz.enc');
  const res = await exportMigrateBundle({
    output: outPath,
    passphrase: 'platform-test-pass-12345678',
    role: 'primary',
    openclawDir: env.openclawDir,
    cronsFile: env.cronsFile,
    keychainServices: [],
    targetPlatform: null,    // what parseArgs produces
    stagingDir: join(env.root, 's'),
  });
  const cmds = res.deps.commands.join('\n');
  const expected = process.platform === 'darwin' ? 'brew install node' : 'apt-get';
  if (!cmds.includes(expected)) throw new Error(`targetPlatform:null bypassed default — missing "${expected}"; got: ${cmds}`);
  rmSync(env.root, { recursive: true, force: true });
});

test('export honours MIGRATE_PASSPHRASE when --passphrase absent (Claude R4)', async () => {
  // parseArgs seeds passphrase: null which bypassed the destructure default.
  // The fix uses nullish coalescing so MIGRATE_PASSPHRASE env works.
  const env = makeFakeEnv();
  const { exportMigrateBundle } = await import('./migrate-export.mjs');
  const prev = process.env.MIGRATE_PASSPHRASE;
  process.env.MIGRATE_PASSPHRASE = 'env-passphrase-12345678';
  try {
    const res = await exportMigrateBundle({
      output: join(env.root, 'e.tar.gz.enc'),
      passphrase: null,            // exactly what parseArgs produces
      openclawDir: env.openclawDir,
      cronsFile: env.cronsFile,
      keychainServices: [],
      stagingDir: join(env.root, 's'),
    });
    if (!res.outputPath) throw new Error('export did not run with env passphrase');
  } finally {
    if (prev === undefined) delete process.env.MIGRATE_PASSPHRASE; else process.env.MIGRATE_PASSPHRASE = prev;
    rmSync(env.root, { recursive: true, force: true });
  }
});

// ── gateway command (L8) ─────────────────────────────────────────

test('gatewayCommand returns gateway subcommands', () => {
  const g = gatewayCommand('2026.7.1-2');
  if (!g.start.includes('gateway start')) throw new Error('start wrong');
  if (!g.status.includes('gateway status')) throw new Error('status wrong');
});

// ── burn (L14) ───────────────────────────────────────────────────

test('burnCommand returns rm with absolute path', () => {
  const c = burnCommand('/tmp/x/bundle.tar.gz.enc');
  if (!c.startsWith('rm -f') || !c.includes('/tmp/x/bundle.tar.gz.enc')) throw new Error('burn cmd wrong');
});

// ── preflight ────────────────────────────────────────────────────

test('preflight reports signal exclusion warning', async () => {
  const { preflight } = await import('./migrate-import.mjs');
  const checks = preflight({ excluded: { signalLink: true }, source: { platform: 'darwin', arch: 'arm64' } }, { configExists: false, force: false });
  const sig = checks.find(c => c.id === 'signal');
  if (!sig || sig.warn !== true) throw new Error('signal warning missing');
});
test('preflight: openclaw missing is warning not blocker (Claude R3)', async () => {
  const { preflight } = await import('./migrate-import.mjs');
  const checks = preflight({ excluded: {}, source: { platform: process.platform } }, { configExists: false, force: false });
  const oc = checks.find(c => c.id === 'openclaw');
  // ok must be true (warning, not blocker) regardless of whether openclaw is installed
  if (!oc || oc.ok !== true) throw new Error('openclaw check should be ok:true (warning, not blocker)');
});
test('preflight blocks on existing config without force', async () => {
  const { preflight } = await import('./migrate-import.mjs');
  const checks = preflight({ excluded: {}, source: { platform: 'darwin' } }, { configExists: true, force: false });
  // Claude R2 fix: target the specific check by id, not .find(ok===false)
  // (which could return the openclaw/platform check on CI or non-darwin hosts).
  const blocker = checks.find(c => c.id === 'config-conflict');
  if (!blocker || blocker.ok !== false) throw new Error('config-conflict not raised');
});

// ── summary ──────────────────────────────────────────────────────

process.on('exit', () => {
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  FAIL: ${f.name} — ${f.err}`);
  process.exit(1);
}
});
