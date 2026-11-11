const {
  addCents,
  centsToDecimal,
  decimalToCents,
} = require('../utils/money');
const { BusinessRuleError } = require('../errors');

function parseLineAmounts(lines) {
  return lines.map((line) => {
    let debitCents;
    let creditCents;

    try {
      debitCents = decimalToCents(line.debit);
      creditCents = decimalToCents(line.credit);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        throw new BusinessRuleError('Line debit and credit must be valid decimal amounts with at most two decimal places');
      }

      throw error;
    }

    const hasDebit = debitCents > 0n;
    const hasCredit = creditCents > 0n;

    if (hasDebit === hasCredit || debitCents < 0n || creditCents < 0n) {
      throw new BusinessRuleError('Each line must have exactly one positive debit or credit amount');
    }

    return {
      accountId: line.accountId,
      debitCents,
      creditCents,
      description: line.description ?? null,
    };
  });
}

async function postJournalEntry(client, {
  companyId,
  date,
  memo = null,
  sourceType,
  sourceId = null,
  reversesEntryId = null,
  lines,
}) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new BusinessRuleError('A journal entry must contain at least two lines');
  }

  const parsedLines = parseLineAmounts(lines);
  const totalDebits = parsedLines.reduce(
    (total, line) => addCents(total, line.debitCents),
    0n,
  );
  const totalCredits = parsedLines.reduce(
    (total, line) => addCents(total, line.creditCents),
    0n,
  );

  if (totalDebits !== totalCredits) {
    throw new BusinessRuleError('Total debits must equal total credits');
  }

  const accountIds = [...new Set(parsedLines.map((line) => line.accountId))];
  const accountResult = await client.query(
    `SELECT id, code, name
     FROM accounts
     WHERE company_id = $1
       AND id = ANY($2::uuid[])
       AND is_active = true`,
    [companyId, accountIds],
  );
  const accountsById = new Map(
    accountResult.rows.map((account) => [account.id.toLowerCase(), account]),
  );

  for (const line of parsedLines) {
    if (!accountsById.has(line.accountId.toLowerCase())) {
      throw new BusinessRuleError('Every journal line must use an active account belonging to the company');
    }
  }

  const entryResult = await client.query(
    `INSERT INTO journal_entries
       (company_id, entry_date, memo, source_type, source_id, reverses_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, company_id, entry_date, memo, source_type, source_id, status, created_at`,
    [companyId, date, memo, sourceType, sourceId, reversesEntryId],
  );
  const entry = entryResult.rows[0];
  const postedLines = [];

  for (const line of parsedLines) {
    const lineResult = await client.query(
      `INSERT INTO journal_lines
         (entry_id, account_id, debit, credit, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, entry_id, account_id, debit, credit, description`,
      [
        entry.id,
        line.accountId,
        centsToDecimal(line.debitCents),
        centsToDecimal(line.creditCents),
        line.description,
      ],
    );
    const postedLine = lineResult.rows[0];
    const account = accountsById.get(postedLine.account_id.toLowerCase());

    postedLines.push({
      id: postedLine.id,
      entryId: postedLine.entry_id,
      accountId: postedLine.account_id,
      debit: centsToDecimal(line.debitCents),
      credit: centsToDecimal(line.creditCents),
      description: postedLine.description,
      accountCode: account.code,
      accountName: account.name,
    });
  }

  return { ...entry, lines: postedLines };
}

module.exports = { postJournalEntry };
