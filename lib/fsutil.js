'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Small file helpers shared by the web/vector stores. Every write is temp file → fsync → rename,
// so a crash can never leave half a file behind.

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

const writeJson = (file, obj) => writeAtomic(file, JSON.stringify(obj));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

function readLines(file, max = 200000) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
    if (out.length >= max) break;
  }
  return out;
}

const sha = (s, alg = 'sha256') => crypto.createHash(alg).update(String(s)).digest('hex');

module.exports = { writeAtomic, writeJson, readJson, appendLine, readLines, sha };
