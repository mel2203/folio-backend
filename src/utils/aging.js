const { centsToDecimal, decimalToCents } = require('./money');

const AGING_BUCKETS = ['current', 'days1To30', 'days31To60', 'days61To90', 'days90Plus'];

function agingBucketSql(dueDateExpression, asOfExpression, outstandingExpression) {
  return {
    current: `SUM(CASE WHEN ${dueDateExpression} >= ${asOfExpression} THEN ${outstandingExpression} ELSE 0 END)::text`,
    days1To30: `SUM(CASE WHEN ${dueDateExpression} < ${asOfExpression} AND ${asOfExpression} - ${dueDateExpression} BETWEEN 1 AND 30 THEN ${outstandingExpression} ELSE 0 END)::text`,
    days31To60: `SUM(CASE WHEN ${asOfExpression} - ${dueDateExpression} BETWEEN 31 AND 60 THEN ${outstandingExpression} ELSE 0 END)::text`,
    days61To90: `SUM(CASE WHEN ${asOfExpression} - ${dueDateExpression} BETWEEN 61 AND 90 THEN ${outstandingExpression} ELSE 0 END)::text`,
    days90Plus: `SUM(CASE WHEN ${asOfExpression} - ${dueDateExpression} > 90 THEN ${outstandingExpression} ELSE 0 END)::text`,
  };
}

function summarizeAging(rows, entityIdField, ledgerBalanceValue) {
  const totals = Object.fromEntries([...AGING_BUCKETS, 'total'].map((key) => [key, 0n]));
  const entities = rows.filter((row) => row[entityIdField]).map((row) => {
    const entity = { ...row };
    for (const key of AGING_BUCKETS) {
      const amount = decimalToCents(row[key] || '0.00');
      totals[key] += amount;
      entity[key] = centsToDecimal(amount);
    }
    const total = decimalToCents(row.total || '0.00');
    totals.total += total;
    entity.total = centsToDecimal(total);
    return entity;
  });
  const ledgerBalance = decimalToCents(ledgerBalanceValue || '0.00');
  const difference = ledgerBalance - totals.total;

  return {
    entities,
    totals: Object.fromEntries([...AGING_BUCKETS, 'total'].map((key) => [key, centsToDecimal(totals[key])])),
    ledgerBalance: centsToDecimal(ledgerBalance),
    difference: centsToDecimal(difference),
    reconciles: difference === 0n,
  };
}

module.exports = { AGING_BUCKETS, agingBucketSql, summarizeAging };
