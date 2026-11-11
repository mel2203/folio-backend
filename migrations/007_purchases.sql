CREATE TABLE IF NOT EXISTS vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 150),
  email TEXT,
  phone TEXT,
  address TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vendors_company ON vendors (company_id);
CREATE INDEX IF NOT EXISTS idx_vendors_company_name ON vendors (company_id, name);
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  vendor_id UUID NOT NULL REFERENCES vendors(id),
  bill_number TEXT NOT NULL CHECK (length(trim(bill_number)) BETWEEN 1 AND 100),
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','partial','paid','void')),
  total NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0 AND amount_paid <= total),
  notes TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  reversal_entry_id UUID REFERENCES journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, vendor_id, bill_number)
);
CREATE INDEX IF NOT EXISTS idx_bills_company ON bills (company_id);
CREATE INDEX IF NOT EXISTS idx_bills_vendor ON bills (vendor_id);
CREATE INDEX IF NOT EXISTS idx_bills_company_vendor ON bills (company_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_bills_status_due_date ON bills (status, due_date);
CREATE INDEX IF NOT EXISTS idx_bills_company_status_due_date ON bills (company_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_bills_company_issue_date ON bills (company_id, issue_date);
ALTER TABLE bills ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS bill_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 250),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  account_id UUID NOT NULL REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items (bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_items_account ON bill_items (account_id);
ALTER TABLE bill_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS bill_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID NOT NULL REFERENCES bills(id),
  payment_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (length(trim(method)) BETWEEN 1 AND 50),
  reference TEXT,
  paying_account_id UUID NOT NULL REFERENCES accounts(id),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bill_payments_bill ON bill_payments (bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_payments_bill_date ON bill_payments (bill_id, payment_date);
ALTER TABLE bill_payments ENABLE ROW LEVEL SECURITY;
