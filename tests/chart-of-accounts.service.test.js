const { seedDefaultAccounts } = require('../src/services/chart-of-accounts.service');

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('seedDefaultAccounts', () => {
  test('inserts the 15 default accounts for the specified company', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rowCount: 1 }),
    };

    await seedDefaultAccounts(client, COMPANY_ID);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (company_id, code) DO NOTHING'),
      [
        COMPANY_ID,
        [
          '1000', '1100', '1200', '1500', '2000',
          '2100', '3000', '3100', '4000', '4100',
          '5000', '6000', '6100', '6200', '6300',
        ],
        [
          'Cash and Bank',
          'Accounts Receivable',
          'Prepaid Expenses',
          'Equipment',
          'Accounts Payable',
          'Sales Tax Payable',
          "Owner's Capital",
          'Retained Earnings',
          'Sales Revenue',
          'Service Revenue',
          'Cost of Goods Sold',
          'Rent Expense',
          'Utilities Expense',
          'Salaries Expense',
          'Office Supplies Expense',
        ],
        [
          'asset', 'asset', 'asset', 'asset', 'liability',
          'liability', 'equity', 'equity', 'revenue', 'revenue',
          'expense', 'expense', 'expense', 'expense', 'expense',
        ],
        [
          'debit', 'debit', 'debit', 'debit', 'credit',
          'credit', 'credit', 'credit', 'credit', 'credit',
          'debit', 'debit', 'debit', 'debit', 'debit',
        ],
      ],
    );
    expect(client.query.mock.calls[0][0]).toContain('unnest($2::text[]');
    expect(client.query.mock.calls[0][1].slice(1).every((values) => values.length === 15)).toBe(true);
  });

  test('propagates a database error on the first insert', async () => {
    const databaseError = new Error('Database failure');
    const client = {
      query: jest.fn().mockRejectedValue(databaseError),
    };

    await expect(seedDefaultAccounts(client, COMPANY_ID)).rejects.toBe(databaseError);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('propagates a synchronous database query error', async () => {
    const databaseError = new Error('Database failure');
    const client = {
      query: jest.fn(() => {
        throw databaseError;
      }),
    };

    await expect(seedDefaultAccounts(client, COMPANY_ID)).rejects.toBe(databaseError);
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
