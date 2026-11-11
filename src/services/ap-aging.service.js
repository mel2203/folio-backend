const { agingBucketSql, summarizeAging } = require('../utils/aging');

async function getApAging(client, companyId, { asOf }) {
  const buckets = agingBucketSql('bill_open.due_date', '$2', 'bill_open.outstanding');
  const result = await client.query(
    `WITH company AS (
       SELECT id, base_currency FROM companies WHERE id = $1
     ),
     bill_open AS (
       SELECT bill.id, bill.vendor_id, bill.due_date,
              bill.total - COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_date <= $2), 0) AS outstanding
       FROM bills bill
       LEFT JOIN bill_payments payment ON payment.bill_id = bill.id
       WHERE bill.company_id = $1 AND bill.issue_date <= $2
         AND bill.status IN ('open', 'partial', 'paid')
       GROUP BY bill.id
     ),
     vendor_aging AS (
       SELECT vendor.id AS "vendorId", vendor.name,
              ${buckets.current} AS current,
              ${buckets.days1To30} AS "days1To30",
              ${buckets.days31To60} AS "days31To60",
              ${buckets.days61To90} AS "days61To90",
              ${buckets.days90Plus} AS "days90Plus",
              SUM(bill_open.outstanding)::text AS total
       FROM bill_open
       JOIN vendors vendor ON vendor.id = bill_open.vendor_id AND vendor.company_id = $1
       WHERE bill_open.outstanding > 0
       GROUP BY vendor.id, vendor.name
     ),
     ap_balance AS (
       SELECT COALESCE(SUM(CASE WHEN entry.id IS NOT NULL THEN line.credit - line.debit ELSE 0 END), 0)::text AS amount
       FROM accounts account
       LEFT JOIN journal_lines line ON line.account_id = account.id
       LEFT JOIN journal_entries entry
         ON entry.id = line.entry_id AND entry.company_id = account.company_id
         AND entry.status = 'posted' AND entry.entry_date <= $2
       WHERE account.company_id = $1 AND account.system_role = 'accounts_payable'
     )
     SELECT company.base_currency AS currency, ap_balance.amount AS "ledgerBalance",
            vendor_aging."vendorId", vendor_aging.name, vendor_aging.current,
            vendor_aging."days1To30", vendor_aging."days31To60",
            vendor_aging."days61To90", vendor_aging."days90Plus", vendor_aging.total
     FROM company CROSS JOIN ap_balance
     LEFT JOIN vendor_aging ON true
     ORDER BY vendor_aging.name ASC NULLS LAST`,
    [companyId, asOf],
  );
  const summary = summarizeAging(result.rows, 'vendorId', result.rows[0]?.ledgerBalance);
  return {
    asOf,
    currency: result.rows[0]?.currency?.trim() || 'MYR',
    vendors: summary.entities.map(({ vendorId, name, ...amounts }) => ({ vendorId, name, ...amounts })),
    totals: summary.totals,
    ledgerBalance: summary.ledgerBalance,
    difference: summary.difference,
    reconciles: summary.reconciles,
  };
}

module.exports = { getApAging };
