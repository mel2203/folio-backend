ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS system_role TEXT;

UPDATE accounts AS account
SET system_role = role_map.system_role
FROM (VALUES
  ('1000', 'cash'),
  ('1100', 'accounts_receivable'),
  ('2000', 'accounts_payable'),
  ('2100', 'sales_tax_payable'),
  ('4000', 'sales_revenue')
) AS role_map(code, system_role)
WHERE account.code = role_map.code
  AND account.system_role IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_company_system_role
  ON accounts (company_id, system_role)
  WHERE system_role IS NOT NULL;
