CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  base_currency CHAR(3) NOT NULL DEFAULT 'MYR',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
  parent_id UUID REFERENCES accounts(id),
  is_active BOOLEAN DEFAULT true,
  UNIQUE (company_id, code)
);

CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  entry_date DATE NOT NULL,
  memo TEXT,
  source_type TEXT CHECK (source_type IN ('manual','invoice','bill','payment','reversal')),
  source_id UUID,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  reverses_entry_id UUID REFERENCES journal_entries(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_entries_company_date ON journal_entries (company_id, entry_date);

CREATE TABLE journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id),
  debit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description TEXT,
  CHECK (NOT (debit > 0 AND credit > 0)),
  CHECK (debit > 0 OR credit > 0)
);
CREATE INDEX idx_lines_account ON journal_lines (account_id);
CREATE INDEX idx_lines_entry ON journal_lines (entry_id);
