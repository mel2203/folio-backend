CREATE TABLE IF NOT EXISTS customers (
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
CREATE INDEX IF NOT EXISTS idx_customers_company ON customers (company_id);
CREATE INDEX IF NOT EXISTS idx_customers_company_name ON customers (company_id, name);
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS document_sequences (
  company_id UUID NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL,
  last_number BIGINT NOT NULL CHECK (last_number >= 0),
  PRIMARY KEY (company_id, kind)
);
ALTER TABLE document_sequences ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  invoice_number TEXT,
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partial','paid','void')),
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_total NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0 AND amount_paid <= total),
  notes TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  reversal_entry_id UUID REFERENCES journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices (company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_company_customer ON invoices (company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status_due_date ON invoices (status, due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_company_status_due_date ON invoices (company_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_company_issue_date ON invoices (company_id, issue_date);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 250),
  quantity NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  revenue_account_id UUID NOT NULL REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_revenue_account ON invoice_items (revenue_account_id);
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  payment_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (length(trim(method)) BETWEEN 1 AND 50),
  reference TEXT,
  deposit_account_id UUID NOT NULL REFERENCES accounts(id),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_company ON payments (company_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_company_invoice ON payments (company_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_date ON payments (invoice_id, payment_date);
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
