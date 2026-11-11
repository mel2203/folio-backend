const { AppError } = require('../errors');

function buildEntryFilters(companyId, filters) {
  const conditions = ['company_id = $1'];
  const values = [companyId];

  if (filters.from) {
    values.push(filters.from);
    conditions.push(`entry_date >= $${values.length}`);
  }

  if (filters.to) {
    values.push(filters.to);
    conditions.push(`entry_date <= $${values.length}`);
  }

  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }

  return { conditions, values };
}

async function listJournalEntries(client, companyId, filters) {
  const { conditions, values } = buildEntryFilters(companyId, filters);
  const whereClause = conditions.join(' AND ');
  const countResult = await client.query(
    `SELECT COUNT(*) AS total
     FROM journal_entries
     WHERE ${whereClause}`,
    values,
  );

  const pageValues = [...values, filters.limit, (filters.page - 1) * filters.limit];
  const entriesResult = await client.query(
    `SELECT id, entry_date, memo, source_type, source_id, status, created_at
     FROM journal_entries
     WHERE ${whereClause}
     ORDER BY entry_date DESC, created_at DESC, id DESC
     LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues,
  );

  return {
    data: entriesResult.rows,
    meta: {
      page: filters.page,
      limit: filters.limit,
      total: Number(countResult.rows[0].total),
    },
  };
}

async function getJournalEntry(client, companyId, entryId) {
  const entryResult = await client.query(
    `SELECT id, entry_date, memo, source_type, source_id, reverses_entry_id, status, created_at
     FROM journal_entries
     WHERE company_id = $1 AND id = $2`,
    [companyId, entryId],
  );

  if (entryResult.rowCount === 0) {
    throw new AppError('Journal entry not found', {
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  }

  const linesResult = await client.query(
    `SELECT jl.id, jl.entry_id AS "entryId", jl.account_id AS "accountId",
            jl.debit, jl.credit, jl.description,
            a.code AS "accountCode", a.name AS "accountName"
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id
     JOIN accounts a ON a.id = jl.account_id AND a.company_id = je.company_id
     WHERE je.company_id = $1 AND je.id = $2
     ORDER BY a.code ASC, jl.id ASC`,
    [companyId, entryId],
  );

  return { ...entryResult.rows[0], lines: linesResult.rows };
}

module.exports = { listJournalEntries, getJournalEntry };
