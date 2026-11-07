const DEFAULT_ACCOUNTS = [
  { code: '1000', name: 'Cash and Bank', type: 'asset', normalBalance: 'debit' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset', normalBalance: 'debit' },
  { code: '1200', name: 'Prepaid Expenses', type: 'asset', normalBalance: 'debit' },
  { code: '1500', name: 'Equipment', type: 'asset', normalBalance: 'debit' },
  { code: '2000', name: 'Accounts Payable', type: 'liability', normalBalance: 'credit' },
  { code: '2100', name: 'Sales Tax Payable', type: 'liability', normalBalance: 'credit' },
  { code: '3000', name: "Owner's Capital", type: 'equity', normalBalance: 'credit' },
  { code: '3100', name: 'Retained Earnings', type: 'equity', normalBalance: 'credit' },
  { code: '4000', name: 'Sales Revenue', type: 'revenue', normalBalance: 'credit' },
  { code: '4100', name: 'Service Revenue', type: 'revenue', normalBalance: 'credit' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', normalBalance: 'debit' },
  { code: '6000', name: 'Rent Expense', type: 'expense', normalBalance: 'debit' },
  { code: '6100', name: 'Utilities Expense', type: 'expense', normalBalance: 'debit' },
  { code: '6200', name: 'Salaries Expense', type: 'expense', normalBalance: 'debit' },
  { code: '6300', name: 'Office Supplies Expense', type: 'expense', normalBalance: 'debit' },
];

async function seedDefaultAccounts(client, companyId) {
  await client.query(
    `INSERT INTO accounts (company_id, code, name, type, normal_balance)
     SELECT $1, account.code, account.name, account.type, account.normal_balance
     FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
       AS account(code, name, type, normal_balance)
     ON CONFLICT (company_id, code) DO NOTHING`,
    [
      companyId,
      DEFAULT_ACCOUNTS.map(({ code }) => code),
      DEFAULT_ACCOUNTS.map(({ name }) => name),
      DEFAULT_ACCOUNTS.map(({ type }) => type),
      DEFAULT_ACCOUNTS.map(({ normalBalance }) => normalBalance),
    ],
  );
}

module.exports = { seedDefaultAccounts };
