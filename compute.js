// Core revenue computation: billing-model classification, month-to-date ->
// full-month projection for Data Fetch usage, the fiscal-year month list,
// and CMGR-based forward projection. Ported from the earlier single-file
// tool's verified logic (Active/Unique Users use the AU count as-is; Data
// Fetch/Fix Billing project the DF count from a month-to-date total to a
// full month using day-of-month / days-in-month).

function normHeader(h) {
  return String(h == null ? '' : h).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

// Maps a Billing Model label (from FIU Metadata config) to which usage
// figure feeds the calculation, plus an informational billing period
// (Quarterly/Annual) when present. "Active Users" and "Unique Users" are
// the same billing model. Blank / "Not billed" / "Unbilled" / anything
// unrecognized is excluded, never guessed.
function classifyBillingModel(billingModel) {
  const m = normHeader(billingModel);
  if (!m) return null;
  let usageType = null;
  if (/active\s*user|unique\s*user/.test(m)) usageType = 'au';
  else if (/data\s*fetch/.test(m)) usageType = 'df';
  else if (/fix(ed)?\s*bill|^fixed$|flat\s*fee/.test(m)) usageType = 'df';
  if (!usageType) return null;
  let periodLabel = null;
  if (/quarter/.test(m)) periodLabel = 'Quarterly';
  else if (/annual|yearly/.test(m)) periodLabel = 'Annual';
  return { usageType, periodLabel };
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[,%\s]/g, '').replace(/[₹$]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? NaN : n;
}

function daysInMonth(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

// Project a month-to-date Data Fetch total to a full-month figure using the
// as-of date's day-of-month and the full length of that month.
function projectMonthToDate(mtdVolume, asOfDate) {
  const day = asOfDate.getUTCDate();
  const dim = daysInMonth(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth() + 1);
  if (day <= 0) return NaN;
  return (mtdVolume / day) * dim;
}

// List of {year, month(1-12)} from the as-of date's month through the end
// of its fiscal year, inclusive. fyStartMonth defaults to 4 (April).
function fyRemainingMonths(asOfDate, fyStartMonth) {
  fyStartMonth = fyStartMonth || 4;
  const asOfYear = asOfDate.getUTCFullYear();
  const asOfMonth = asOfDate.getUTCMonth() + 1;
  const fyEndYear = asOfMonth >= fyStartMonth ? asOfYear + 1 : asOfYear;
  const fyEndMonth = fyStartMonth === 1 ? 12 : fyStartMonth - 1; // month right before FY start
  const months = [];
  let y = asOfYear, m = asOfMonth;
  // Safety cap at 12 iterations — a fiscal year is never longer than that.
  for (let i = 0; i < 12; i++) {
    months.push({ year: y, month: m });
    if (y === fyEndYear && m === fyEndMonth) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

function monthLabel(year, month1to12) {
  return new Date(Date.UTC(year, month1to12 - 1, 1))
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// counts: array of { fiuId, activeUsers, dataFetches }
// metadataById: Map(normId -> { fiuId, legalName, tspName, licenseType, useCase, billingModel })
// yieldCmgrById: Map(normId -> { fiuId, yield, cmgr })
// asOfDate: JS Date the counts were pulled as of (drives current-month MTD projection and the FY month list)
function computeRevenue(counts, metadataById, yieldCmgrById, asOfDate, fyStartMonth) {
  const months = fyRemainingMonths(asOfDate, fyStartMonth);
  const monthCols = months.map((m, i) => ({ ...m, label: monthLabel(m.year, m.month), isCurrent: i === 0 }));

  const rows = [];
  const unmatchedCounts = []; // FIU IDs present in the upload but missing from FIU Metadata config
  const seenKeys = new Set();

  for (const c of counts) {
    const fiuId = String(c.fiuId || '').trim();
    if (!fiuId) continue;
    const key = fiuId.trim().toUpperCase();
    seenKeys.add(key);
    const meta = metadataById.get(key);
    const yc = yieldCmgrById.get(key);

    if (!meta) {
      unmatchedCounts.push(fiuId);
      continue;
    }

    const billingInfo = classifyBillingModel(meta.billingModel);
    const notBillable = billingInfo === null;
    const yieldValue = yc ? toNumber(yc.yield) : NaN;
    const cmgr = yc ? toNumber(yc.cmgr) : 0;
    const cmgrRate = isNaN(cmgr) ? 0 : cmgr;

    const auCount = toNumber(c.activeUsers);
    const dfCount = toNumber(c.dataFetches);

    let baselineUsage = NaN;
    if (billingInfo) {
      if (billingInfo.usageType === 'au') baselineUsage = auCount;
      else baselineUsage = isNaN(dfCount) ? NaN : projectMonthToDate(dfCount, asOfDate);
    }

    const hasData = !notBillable && !isNaN(baselineUsage) && !isNaN(yieldValue);

    const monthly = monthCols.map((mc, i) => {
      if (!hasData) return { usage: NaN, revenue: NaN };
      const usage = baselineUsage * Math.pow(1 + cmgrRate, i); // i=0 -> current month, no growth applied
      const revenue = usage * yieldValue;
      return { usage, revenue };
    });

    rows.push({
      fiuId,
      legalName: meta.legalName || '',
      tspName: meta.tspName || '',
      licenseType: meta.licenseType || '',
      useCase: meta.useCase || '',
      billingModel: meta.billingModel || '—',
      billingPeriod: billingInfo ? billingInfo.periodLabel : null,
      usageType: billingInfo ? billingInfo.usageType : null,
      yieldValue,
      cmgr: cmgrRate,
      hasData,
      notBillable,
      missingYieldOrCmgrConfig: !yc,
      monthly
    });
  }

  const unmatchedMeta = []; // FIU IDs in config with no counts in this month's upload
  metadataById.forEach((meta, key) => {
    if (!seenKeys.has(key)) unmatchedMeta.push(meta.fiuId);
  });

  const totalsByMonth = monthCols.map((mc, i) =>
    rows.filter(r => r.hasData).reduce((s, r) => s + (r.monthly[i].revenue || 0), 0)
  );

  return { months: monthCols, rows, totalsByMonth, unmatchedCounts, unmatchedMeta };
}

module.exports = {
  normHeader,
  classifyBillingModel,
  toNumber,
  daysInMonth,
  projectMonthToDate,
  fyRemainingMonths,
  monthLabel,
  computeRevenue
};
