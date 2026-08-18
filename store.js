// Tiny JSON-file-backed store — no database server required. Good fit for a
// few hundred FIU rows maintained by a small team. Each "table" is a single
// JSON file under data/ containing an array of row objects, upserted by
// fiuId. Swap this module out for a real database later if concurrent
// multi-writer access ever becomes a problem.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function filePath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function ensureFile(name) {
  const p = filePath(name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf8');
  return p;
}

function readAll(name) {
  const p = ensureFile(name);
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('Corrupt data file ' + p + ': ' + err.message);
  }
}

function writeAll(name, rows) {
  const p = ensureFile(name);
  // Write to a temp file then rename — avoids truncating the file if the
  // process is killed mid-write.
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function normId(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

// Upsert a single row by fiuId (case-insensitive match on fiuId).
function upsert(name, row) {
  if (!row || !row.fiuId || !String(row.fiuId).trim()) {
    throw new Error('fiuId is required');
  }
  const rows = readAll(name);
  const key = normId(row.fiuId);
  const idx = rows.findIndex(r => normId(r.fiuId) === key);
  const clean = { ...row, fiuId: String(row.fiuId).trim() };
  if (idx === -1) rows.push(clean);
  else rows[idx] = { ...rows[idx], ...clean };
  writeAll(name, rows);
  return clean;
}

// Upsert many rows at once (bulk import). Returns count.
function upsertMany(name, incomingRows) {
  const rows = readAll(name);
  const byKey = new Map(rows.map(r => [normId(r.fiuId), r]));
  let created = 0, updated = 0;
  for (const row of incomingRows) {
    if (!row || !row.fiuId || !String(row.fiuId).trim()) continue;
    const key = normId(row.fiuId);
    const clean = { ...row, fiuId: String(row.fiuId).trim() };
    if (byKey.has(key)) { byKey.set(key, { ...byKey.get(key), ...clean }); updated++; }
    else { byKey.set(key, clean); created++; }
  }
  writeAll(name, Array.from(byKey.values()));
  return { created, updated, total: byKey.size };
}

function remove(name, fiuId) {
  const rows = readAll(name);
  const key = normId(fiuId);
  const next = rows.filter(r => normId(r.fiuId) !== key);
  const removed = next.length !== rows.length;
  if (removed) writeAll(name, next);
  return removed;
}

module.exports = { readAll, writeAll, upsert, upsertMany, remove, normId };
