const { postJournalEntry } = require('../src/services/journal.service');

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CASH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAPITAL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENTRY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function createClient({ inactiveAccountId } = {}) {
  const queries = [];
  let insertedLineId = 0;
  const accounts = [
    { id: CASH_ID, code: '1000', name: 'Cash and Bank' },
    { id: CAPITAL_ID, code: '3000', name: "Owner's Capital" },
  ].filter((account) => account.id !== inactiveAccountId);

  return {
    queries,
    async query(sql, values = []) {
      queries.push({ sql, values });

      if (sql.includes('FROM accounts')) {
        expect(values[0]).toBe(COMPANY_ID);
        return { rows: accounts };
      }

      if (sql.includes('INSERT INTO journal_entries')) {
        return {
          rows: [{
            id: ENTRY_ID,
            company_id: values[0],
            entry_date: values[1],
            memo: values[2],
            source_type: values[3],
            source_id: values[4],
            status: 'posted',
            created_at: '2026-11-05T00:00:00.000Z',
          }],
        };
      }

      if (sql.includes('INSERT INTO journal_lines')) {
        insertedLineId += 1;
        return {
          rows: [{
            id: `line-${insertedLineId}`,
            entry_id: values[0],
            account_id: values[1],
            debit: values[2],
            credit: values[3],
            description: values[4],
          }],
        };
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
}

const validEntry = {
  companyId: COMPANY_ID,
  date: '2026-11-05',
  memo: 'Owner invests cash',
  sourceType: 'manual',
  lines: [
    {
      accountId: CASH_ID,
      debit: '5000.00',
      credit: '0.00',
      description: 'Cash in',
    },
    {
      accountId: CAPITAL_ID,
      debit: '0.00',
      credit: '5000.00',
      description: 'Capital',
    },
  ],
};

describe('postJournalEntry', () => {
  test('inserts a balanced entry and returns its lines with account details', async () => {
    const client = createClient();

    const entry = await postJournalEntry(client, validEntry);

    expect(entry.id).toBe(ENTRY_ID);
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0]).toMatchObject({
      accountId: CASH_ID,
      accountCode: '1000',
      accountName: 'Cash and Bank',
      debit: '5000.00',
      credit: '0.00',
    });
    expect(client.queries.filter(({ sql }) => sql.includes('INSERT INTO journal_entries')))
      .toHaveLength(1);
    expect(client.queries.filter(({ sql }) => sql.includes('INSERT INTO journal_lines')))
      .toHaveLength(2);
  });

  test('rejects unbalanced totals before inserting the entry', async () => {
    const client = createClient();
    const request = {
      ...validEntry,
      lines: [
        { ...validEntry.lines[0], debit: '10.01' },
        { ...validEntry.lines[1], credit: '10.00' },
      ],
    };

    await expect(postJournalEntry(client, request)).rejects.toMatchObject({
      statusCode: 422,
      code: 'BUSINESS_RULE_VIOLATION',
    });
    expect(client.queries).toHaveLength(0);
  });

  test('rejects a line with both a debit and credit before inserting', async () => {
    const client = createClient();
    const request = {
      ...validEntry,
      lines: [
        { ...validEntry.lines[0], debit: '5.00', credit: '1.00' },
        { ...validEntry.lines[1], debit: '0.00', credit: '5.00' },
      ],
    };

    await expect(postJournalEntry(client, request)).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(client.queries).toHaveLength(0);
  });

  test('rejects fewer than two lines before querying accounts', async () => {
    const client = createClient();

    await expect(postJournalEntry(client, {
      ...validEntry,
      lines: [validEntry.lines[0]],
    })).rejects.toMatchObject({ statusCode: 422 });
    expect(client.queries).toHaveLength(0);
  });

  test('rejects an account that is not returned for the company', async () => {
    const client = createClient();
    const request = {
      ...validEntry,
      lines: [
        validEntry.lines[0],
        { ...validEntry.lines[1], accountId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      ],
    };

    await expect(postJournalEntry(client, request)).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(client.queries.some(({ sql }) => sql.includes('INSERT INTO journal_entries')))
      .toBe(false);
  });

  test('rejects an inactive account', async () => {
    const client = createClient({ inactiveAccountId: CAPITAL_ID });

    await expect(postJournalEntry(client, validEntry)).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(client.queries.some(({ sql }) => sql.includes('INSERT INTO journal_entries')))
      .toBe(false);
  });

  test('rejects amounts with more than two decimal places', async () => {
    const client = createClient();
    const request = {
      ...validEntry,
      lines: [
        { ...validEntry.lines[0], debit: '5000.001' },
        validEntry.lines[1],
      ],
    };

    await expect(postJournalEntry(client, request)).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(client.queries).toHaveLength(0);
  });
});
