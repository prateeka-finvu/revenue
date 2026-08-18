const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const store = require('./lib/store');
const { parseWorkbook, findMasterDataSheet } = require('./lib/parseFile');
const { buildColumnMap } = require('./lib/columns');
const { computeRevenue, toNumber } = require('./lib/compute');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const META_TABLE = 'fiu-metadata';
const YC_TABLE = 'yield-cmgr';

function toMetaRow(r) {
  return {
    fiuId: r.fiuId,
    legalName: r.legalName || '',
    tspName: r.tspName || '',
    licenseType: r.licenseType || '',
    useCase: r.useCase || '',
    billingModel: r.billingModel || ''
  };
}
function toYcRow(r) {
  return { fiuId: r.fiuId, yield: r.yield, cmgr: r.cmgr };
}

// ---------- FIU Metadata config ----------
app.get('/api/fiu-metadata', (req, res) => {
  res.json(store.readAll(META_TABLE));
});
app.post('/api/fiu-metadata', (req, res) => {
  try {
    res.json(store.upsert(META_TABLE, toMetaRow(req.body)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/fiu-metadata/:fiuId', (req, res) => {
  try {
    res.json(store.upsert(META_TABLE, toMetaRow({ ...req.body, fiuId: req.params.fiuId })));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/fiu-metadata/:fiuId', (req, res) => {
  const removed = store.remove(META_TABLE, req.params.fiuId);
  if (!removed) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---------- Yield / CMGR config ----------
app.get('/api/yield-cmgr', (req, res) => {
  res.json(store.readAll(YC_TABLE));
});
app.post('/api/yield-cmgr', (req, res) => {
  try {
    res.json(store.upsert(YC_TABLE, toYcRow(req.body)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/yield-cmgr/:fiuId', (req, res) => {
  try {
    res.json(store.upsert(YC_TABLE, toYcRow({ ...req.body, fiuId: req.params.fiuId })));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/yield-cmgr/:fiuId', (req, res) => {
  const removed = store.remove(YC_TABLE, req.params.fiuId);
  if (!removed) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---------- Convenience: seed both configs from a Master-Data-style file ----------
// Accepts the same file shape used previously (a sheet named "Master Data"
// with fiu_id, fiu_name, TSP, License, Use-case, Billing Model, a yield
// column, and optionally a CMGR/"Q2 CMGR Forecast" column). Upserts into
// both the FIU Metadata and Yield/CMGR configs so a team that already has
// this data doesn't have to retype ~500 rows by hand.
app.post('/api/seed-from-master-data', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let sheetNames, sheets;
  try {
    ({ sheetNames, sheets } = parseWorkbook(req.file.buffer));
  } catch (err) {
    return res.status(400).json({ error: 'Could not read file: ' + err.message });
  }
  const masterName = findMasterDataSheet(sheetNames);
  if (!masterName) {
    return res.status(400).json({ error: 'Could not find a sheet named "Master Data". Sheets found: ' + sheetNames.join(', ') });
  }
  const rows = sheets[masterName];
  if (!rows.length) return res.status(400).json({ error: '"Master Data" sheet is empty' });

  const colMap = buildColumnMap(rows[0], ['fiuId', 'legalName', 'tspName', 'licenseType', 'useCase', 'billingModel', 'yieldValue', 'cmgr']);
  if (!colMap.fiuId) return res.status(400).json({ error: 'Could not find an FIU ID column in "Master Data"' });

  const metaRows = [];
  const ycRows = [];
  rows.forEach(r => {
    const fiuId = String(r[colMap.fiuId] || '').trim();
    if (!fiuId) return;
    metaRows.push(toMetaRow({
      fiuId,
      legalName: colMap.legalName ? r[colMap.legalName] : '',
      tspName: colMap.tspName ? r[colMap.tspName] : '',
      licenseType: colMap.licenseType ? r[colMap.licenseType] : '',
      useCase: colMap.useCase ? r[colMap.useCase] : '',
      billingModel: colMap.billingModel ? r[colMap.billingModel] : ''
    }));
    const y = colMap.yieldValue ? toNumber(r[colMap.yieldValue]) : NaN;
    const g = colMap.cmgr ? toNumber(r[colMap.cmgr]) : NaN;
    ycRows.push(toYcRow({
      fiuId,
      yield: isNaN(y) ? '' : y,
      cmgr: isNaN(g) ? '' : g
    }));
  });

  const metaResult = store.upsertMany(META_TABLE, metaRows);
  const ycResult = store.upsertMany(YC_TABLE, ycRows);
  res.json({
    sheetUsed: masterName,
    ignoredSheets: sheetNames.filter(n => n !== masterName),
    columnsFound: colMap,
    metadata: metaResult,
    yieldCmgr: ycResult
  });
});

// ---------- Monthly upload + revenue computation ----------
// Expects a file with FIU ID, AU count (active_users), DF count
// (successful_data_fetches) only — no yield, no billing model. Those come
// from the two configs above, joined server-side by FIU ID.
app.post('/api/compute', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let sheetNames, sheets;
  try {
    ({ sheetNames, sheets } = parseWorkbook(req.file.buffer));
  } catch (err) {
    return res.status(400).json({ error: 'Could not read file: ' + err.message });
  }
  // Counts files are typically a single sheet; if multiple, prefer one
  // literally named "Master Data" for consistency with earlier files, else
  // just use the first sheet.
  const masterName = findMasterDataSheet(sheetNames) || sheetNames[0];
  const rows = sheets[masterName];
  if (!rows || !rows.length) return res.status(400).json({ error: 'No data rows found in the uploaded file' });

  const colMap = buildColumnMap(rows[0], ['fiuId', 'activeUsers', 'dataFetches']);
  if (!colMap.fiuId) return res.status(400).json({ error: 'Could not find an FIU ID column' });

  const counts = rows.map(r => ({
    fiuId: r[colMap.fiuId],
    activeUsers: colMap.activeUsers ? r[colMap.activeUsers] : '',
    dataFetches: colMap.dataFetches ? r[colMap.dataFetches] : ''
  })).filter(c => String(c.fiuId || '').trim());

  const asOfDate = req.body.asOfDate ? new Date(req.body.asOfDate + 'T00:00:00Z') : new Date();
  const fyStartMonth = req.body.fyStartMonth ? parseInt(req.body.fyStartMonth, 10) : 4;

  const metaRows = store.readAll(META_TABLE);
  const ycRows = store.readAll(YC_TABLE);
  const metadataById = new Map(metaRows.map(r => [store.normId(r.fiuId), r]));
  const yieldCmgrById = new Map(ycRows.map(r => [store.normId(r.fiuId), r]));

  const result = computeRevenue(counts, metadataById, yieldCmgrById, asOfDate, fyStartMonth);
  res.json({
    sheetUsed: masterName,
    ignoredSheets: sheetNames.filter(n => n !== masterName),
    asOfDate: asOfDate.toISOString().slice(0, 10),
    ...result
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('FIU Revenue Estimator backend listening on port ' + PORT);
});
