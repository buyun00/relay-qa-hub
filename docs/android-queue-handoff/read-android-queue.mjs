// Node.js 24+. Reads the phone; writes only a NEW directory on this computer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--include-media') options.media = true;
  else if (['--adb', '--serial', '--package', '--actor', '--out'].includes(key)) {
    const value = process.argv[++i];
    if (!value || value.startsWith('--')) throw Error(`Missing value: ${key}`);
    options[key.slice(2)] = value;
  } else throw Error(`Unknown option: ${key}`);
}
if (!options.serial) throw Error('Specify --serial from adb devices -l; never guess the phone.');
const adb = options.adb || 'adb';
const serial = options.serial;
const pkg = options.package || 'com.relayqahub.android.debug';
if (!/^[A-Za-z0-9_.:-]+$/.test(serial)) throw Error('Invalid device serial.');
if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) {
  throw Error('Invalid package name.');
}
if (options.actor && !/^[0-9a-f-]{36}$/i.test(options.actor)) throw Error('Invalid actor UUID.');
const out = path.resolve(options.out || `qa-queue-${new Date().toISOString().replace(/[:.]/g, '-')}`);
if (fs.existsSync(out)) throw Error('Output already exists. Choose a NEW directory; do not overwrite evidence.');
fs.mkdirSync(out, { recursive: true });
const writeJson = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const call = (...args) => execFileSync(adb, ['-s', serial, ...args], {
  timeout: 60000, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const privateRead = (...args) => call('exec-out', 'run-as', pkg, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = new Date().toISOString();

try {
  if (call('get-state').toString().trim() !== 'device') throw Error('Device not ready.');
  privateRead('id'); // Fail if installed APK is not debuggable; never reinstall/root to bypass.
  const packageInfo = call('shell', 'dumpsys', 'package', pkg).toString();
  fs.writeFileSync(path.join(out, 'device.txt'), [
    `serial=${serial}`, `package=${pkg}`, `startedAt=${startedAt}`,
    ...packageInfo.split(/\r?\n/).filter((line) => /versionCode=|versionName=/.test(line)),
    call('shell', 'dumpsys', 'battery').toString(),
  ].join('\n'));

  const dbName = 'qa-hub-cache-v1.db';
  function readPass() {
    const names = privateRead('ls', '-1', 'databases').toString().trim().split(/\r?\n/);
    if (!names.includes(dbName)) throw Error('Expected database absent; verify package/profile/version.');
    const files = {};
    for (const name of [dbName, `${dbName}-wal`, `${dbName}-shm`]) {
      if (names.includes(name)) files[name] = privateRead('cat', `databases/${name}`);
    }
    return files;
  }
  // Best-effort live capture, NOT an Android-side atomic SQLite backup.
  // Compare DB and WAL across two passes. SHM is transient and is not used for stability.
  const signature = (files) => JSON.stringify([dbName, `${dbName}-wal`].map(
    (name) => [name, files[name] ? hash(files[name]) : null],
  ));
  let snapshot;
  let snapshotStartedAt;
  let snapshotFinishedAt;
  for (let attempt = 1; attempt <= 5; attempt++) {
    snapshotStartedAt = new Date().toISOString();
    try {
      const first = readPass();
      const second = readPass();
      if (signature(first) === signature(second)) {
        snapshot = second;
        snapshotFinishedAt = new Date().toISOString();
        break;
      }
    } catch (error) {
      if (attempt === 5) throw error;
    }
    await sleep(500);
  }
  if (!snapshot) throw Error('Database changed during capture. Retry later; do not force-stop/clear the app.');
  const raw = path.join(out, 'raw');
  const analysis = path.join(out, 'analysis');
  fs.mkdirSync(raw);
  fs.mkdirSync(analysis);
  for (const [name, bytes] of Object.entries(snapshot)) {
    fs.writeFileSync(path.join(raw, name), bytes, { flag: 'wx' });
    // Let SQLite rebuild SHM on the computer, preserving original evidence in raw/.
    if (!name.endsWith('-shm')) fs.writeFileSync(path.join(analysis, name), bytes, { flag: 'wx' });
  }
  writeJson('snapshot.json', {
    startedAt, snapshotStartedAt, snapshotFinishedAt, serial, package: pkg,
    method: 'Two matching DB/WAL reads; best-effort live capture, not an atomic phone backup.',
    files: Object.entries(snapshot).map(([name, bytes]) => ({ name, size: bytes.length, sha256: hash(bytes) })),
  });

  const db = new DatabaseSync(path.join(analysis, dbName), { readOnly: true });
  let operations;
  let receipts;
  try {
    db.exec('PRAGMA query_only=ON');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    writeJson('integrity.json', { integrity, foreignKeys });
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok' || foreignKeys.length) {
      throw Error('Snapshot integrity check failed. Do not infer an empty queue.');
    }
    // Do NOT filter by date or current session: old blocked operations also matter.
    operations = options.actor
      ? db.prepare('SELECT * FROM offline_operations WHERE actorId = ? ORDER BY createdAtEpochMs').all(options.actor)
      : db.prepare('SELECT * FROM offline_operations ORDER BY createdAtEpochMs').all();
    receipts = db.prepare('SELECT * FROM offline_operation_receipts').all();
  } finally {
    db.close();
  }
  const receiptMap = new Map(receipts.map((r) => [r.operationId, r]));
  const scopeKeys = ['accountId', 'projectId', 'actorId', 'installationId', 'sessionId'];
  const validStates = new Set(['PENDING', 'RUNNING', 'RETRY', 'BLOCKED_AUTH', 'BLOCKED_DEVICE', 'FAILED_PERMANENT', 'SUCCEEDED']);
  const iso = (ms) => Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null;
  const records = operations.map((op) => {
    let payload = {};
    let payloadError = null;
    try { payload = JSON.parse(op.payloadJson); } catch { payloadError = 'INVALID_PAYLOAD_JSON'; }
    const receipt = receiptMap.get(op.operationId);
    const receiptMatches = Boolean(receipt && scopeKeys.every((key) => receipt[key] === op[key]) &&
      payload.clientSubmissionId && receipt.clientSubmissionId === payload.clientSubmissionId &&
      receipt.qaItemId && receipt.bugId === receipt.qaItemId && receipt.qaItemKey);
    return {
      operationId: op.operationId, ...Object.fromEntries(scopeKeys.map((key) => [key, op[key]])),
      operationKind: op.operationKind, state: op.state, attemptCount: op.attemptCount,
      lastErrorCode: op.lastErrorCode, createdAt: iso(op.createdAtEpochMs),
      updatedAt: iso(op.updatedAtEpochMs), nextAttemptAt: iso(op.nextAttemptAtEpochMs),
      clientSubmissionId: payload.clientSubmissionId || null,
      title: payload.title || '', description: payload.description || '',
      observedAt: payload.observedAt || null, captureId: payload.captureId || null,
      attachments: payload.attachments || [], payloadError,
      receiptPresent: Boolean(receipt), receiptMatches,
      bugId: receipt?.bugId || null, bugKey: receipt?.qaItemKey || null,
      receivedAt: receipt ? iso(receipt.receivedAtEpochMs) : null,
    };
  });
  const counts = {};
  const scopes = {};
  for (const r of records) {
    counts[r.state] = (counts[r.state] || 0) + 1;
    const key = scopeKeys.map((k) => r[k]).join('/');
    scopes[key] ||= {};
    scopes[key][r.state] = (scopes[key][r.state] || 0) + 1;
  }
  const nonSucceeded = records.filter((r) => r.state !== 'SUCCEEDED');
  const inconsistent = records.filter((r) => !validStates.has(r.state) || r.payloadError ||
    (r.state === 'SUCCEEDED' && !r.receiptMatches) || (r.receiptPresent && !r.receiptMatches));
  const summary = {
    snapshotStartedAt, snapshotFinishedAt, serial, package: pkg, actorFilter: options.actor || null,
    totalOperations: records.length, counts, scopes,
    nonSucceededCount: nonSucceeded.length, inconsistentCount: inconsistent.length,
    allRecordedOperationsConfirmedInLocalSnapshot:
      records.length > 0 && nonSucceeded.length === 0 && inconsistent.length === 0,
    limitation: 'Only this device/package and captured database; excludes unsaved form text, other profiles/devices, and later changes. A local receipt is not a fresh server verification.',
  };
  writeJson('queue-report.json', { summary, records });
  writeJson('queue-attention.json', records.filter((r) => nonSucceeded.includes(r) || inconsistent.includes(r)));

  // Optional media preservation. Fixed app-owned paths only; never shared_prefs/credentials.
  const media = [];
  if (options.media) {
    const names = privateRead('ls', '-1', 'files').toString().trim().split(/\r?\n/);
    for (const dir of ['offline-submission-drafts', 'capture-drafts']) {
      if (!names.includes(dir)) { media.push({ directory: dir, status: 'absent' }); continue; }
      const target = path.join(out, `${dir}.tar`);
      const fd = fs.openSync(target, 'wx');
      let result;
      try {
        result = spawnSync(adb, ['-s', serial, 'exec-out', 'run-as', pkg, 'tar', '-cf', '-', `files/${dir}`], {
          timeout: 60000, windowsHide: true, stdio: ['ignore', fd, 'pipe'],
        });
      } finally { fs.closeSync(fd); }
      media.push({ directory: dir, status: result?.status === 0 ? 'exported' : 'FAILED_OR_CHANGED',
        file: path.basename(target), size: fs.statSync(target).size,
        stderr: result?.stderr?.toString().slice(0, 2000) || null });
    }
    writeJson('media-export.json', { note: 'Media is read AFTER DB snapshot; files may change during sync. Do not treat absence as proof of loss.', media });
  }
  console.log(JSON.stringify({ output: out, summary, media }, null, 2));
} catch (error) {
  // Do not dump raw buffers, database payloads, or credentials on errors.
  const message = String(error.message).slice(0, 3000);
  writeJson('FAILED.json', { at: new Date().toISOString(), message, conclusion: 'Unknown; not an empty queue.' });
  console.error(message);
  process.exitCode = 1;
}
