# Sales backend — explained

## 1. Summary

This stage adds customers, draft invoices, invoice sending, payments, void reversals, and Accounts Receivable aging. The new migration creates five RLS-enabled tables. Invoice and payment posting uses the existing journal service inside the same database transaction as each document update. Invoice amounts are calculated on the server in integer cents. The client repository has not been changed; the backend checkpoint stops here for review of the API response shapes.

## 2. One request end to end

Consider `POST /api/invoices/:id/send`. [src/routes/invoice.routes.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/routes/invoice.routes.js:7) attaches the route validator and controller. The send validator checks the UUID and requires an empty request body in [src/validators/sales.validator.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/validators/sales.validator.js:143). The controller starts a database transaction and returns `{ "data": invoiceDetail }` in [src/controllers/invoice.controller.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/controllers/invoice.controller.js:40). [src/services/invoice.service.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/services/invoice.service.js:265) locks the draft invoice, verifies the active customer and revenue accounts, atomically increments that company's invoice sequence, calculates the balanced posting lines, calls `postJournalEntry`, and changes the invoice to sent. The writes commit together. The journal service checks line balance and active same-company accounts before inserting [src/services/journal.service.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/services/journal.service.js:34). A future invoice detail page can consume the returned customer, line calculations, status, number, and journal-entry ID; that page is not part of this backend stage.

## 3. Journal entries created

| Event | Debit | Credit | Example | Statement effect |
|---|---|---|---:|---|
| Send an invoice | Accounts Receivable, total | Each revenue account, line net; Sales Tax Payable, tax total when nonzero | 106.00 = 100.00 net + 6.00 tax | Increases A/R and revenue; tax increases the liability. |
| Record a payment | Selected deposit asset | Accounts Receivable | 50.00 | Increases cash/bank and reduces A/R; no revenue is recorded again. |
| Void an unpaid sent invoice | Original credits (revenue and tax) | Original A/R debit | Reverses the 106.00 example | Reverses the original posting through a new posted journal entry. |

No journal entry is created for customer maintenance or draft invoice create/edit/delete. The system does not edit or delete posted entries.

## 4. New tables and columns

Migration [migrations/006_sales.sql](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/migrations/006_sales.sql:1) adds:

- `customers`: company-owned contact records, payment terms, and active state.
- `document_sequences`: one atomic number counter per company and document kind.
- `invoices`: customer, dates, status, calculated totals, paid amount, notes, and original/reversal journal-entry IDs. Invoice numbers are nullable until send and unique within a company when present.
- `invoice_items`: quantity, unit price, tax rate, description, and revenue account. Database checks require positive quantity and tax from 0 through 100.
- `payments`: date, positive amount, method/reference, deposit account, and posted journal-entry ID.

Every new table enables row level security in the same migration. Company, customer, status/due-date, invoice, and account lookup indexes are included.

## 5. Rules that protect the data

| Rule | Enforcement |
|---|---|
| Request shapes, calendar dates, decimals, pagination, filters | Zod schemas in `src/validators/sales.validator.js` lines 4–162. The central middleware returns the existing 400 error format. |
| Company isolation | Controllers pass only `req.companyId`; list, detail, update, and write queries bind it as a parameter. Invoice item reads/writes join through the company-owned invoice. |
| Active customer and same-company active revenue accounts | `invoice.service.js` lines 51–71, checked for draft creation/update and again before sending. |
| Accurate line rounding | `invoice.service.js` lines 6–39 uses BigInt integer units and half-up division. It rounds each net and tax line before summing. |
| No invoice number on draft; atomic sequence on send | `invoice.service.js` lines 253–263 runs an upsert inside the send transaction. Failed sends roll the increment back. |
| Journal entries balance and use active same-company accounts | Existing `postJournalEntry` in `src/services/journal.service.js` lines 34–100. Its new optional `reversesEntryId` parameter preserves reversal linkage. |
| Draft-only edit/delete; valid status changes; no overpayment | `invoice.service.js` update/delete/send/payment/void functions. Invoice rows are locked while status and paid amount are checked. |
| Payment deposit is active asset; A/R uses system role | `invoice.service.js` payment path looks up the deposit account by company/type/active state and A/R by `system_role`. |
| Historical aging and reconciliation | `src/services/ar-aging.service.js` lines 4–80 filters invoices by company, issue date, status, and payment date; the A/R ledger balance includes posted lines through `asOf`. |

All money arithmetic is integer cents in JavaScript. PostgreSQL stores document money as NUMERIC values and API money values are decimal strings. Dates remain `YYYY-MM-DD`; default dates use the Kuala Lumpur helper and due-date addition is performed by PostgreSQL `DATE + integer`, without JavaScript timezone conversion.

## 6. Tests and what they prove

`tests/invoice-rounding.test.js` checks the 0.25 × 1.00 at 6% example (0.02 tax) and a half-up line-net case. `tests/sales.integration.test.js` checks customer CRUD/list scope and authentication; due-date defaults; draft numbering and gapless sends; exact revenue/A/R/tax lines; zero-tax omission; failed-send sequence rollback; cross-company and inactive references; tenant-isolated invoice lists; draft-only edits/deletes; partial/full payments and overpayment; unpaid-only void plus A/R reversal; report effects; aging date boundaries and as-of payments; manual A/R reconciliation difference; and invalid dates/ranges.

Ran `NODE_ENV=test npm test`: **Test Suites: 10 passed, 10 total; Tests: 89 passed, 89 total**. The integration test harness applies migrations using the configured test database. No production or development database was intentionally used. Not verified: browser behavior, frontend rendering, concurrent send stress beyond the atomic SQL operation, or a live production deployment.

## 7. How to try the API

Start the backend and use a bearer token obtained through the existing login flow. Keep the token in a shell variable rather than printing it.

1. Create a customer with `POST /api/customers` and body `{"name":"Example Customer","paymentTermsDays":30}`. Expect HTTP 201 and `{ "data": { "id": "...", "paymentTermsDays": 30, "isActive": true, ... } }`.
2. Create a draft with `POST /api/invoices`, an active `customerId`, and an item with `quantity`, `unitPrice`, `taxRate`, and an active revenue account ID. Expect HTTP 201, `status: "draft"`, `invoiceNumber: null`, computed totals, a customer object, item calculations, and `payments: []`.
3. Send it with `POST /api/invoices/<id>/send` and `{}`. Expect HTTP 200, an `INV-####` number, `status: "sent"`, and a `journalEntryId`.
4. Record payment with `POST /api/invoices/<id>/payments` and a positive amount plus an active asset `depositAccountId`. Expect HTTP 201 with `{ "data": { "payment": ..., "invoice": ... } }`; status becomes `partial` or `paid`.
5. Read `GET /api/reports/ar-aging?asOf=YYYY-MM-DD`. Expect per-customer and total buckets, A/R ledger balance, `difference` (ledger balance minus aging total), and `reconciles`.

All write examples require `Content-Type: application/json` and `Authorization: Bearer <token>`. Do not include real passwords or tokens in shared logs.

## 8. Decisions and limitations

Quantities, prices, and rates are accepted as decimal strings, which avoids binary floating-point arithmetic. A zero-total draft may be saved but cannot be sent because a journal line must have a positive side. The payment method is a required short text field rather than a fixed enum. Aging omits customers with no positive outstanding balance. `difference` is defined as ledger A/R less the aging total. Credit notes, refunds, recurring invoices, email delivery, gateways, multi-currency, and voiding payments are not built.

## 9. Examiner questions and a short presentation

1. **Why is the invoice number assigned on send?** Drafts remain unnumbered; the sequence upsert happens inside the same transaction as posting.
2. **How do you avoid rounding drift?** Each line net and tax is rounded half up in integer cents before totals are added.
3. **Why does a payment not create revenue?** Revenue was recorded on send; payment debits the deposit account and credits A/R.
4. **How is a void represented?** A new posted journal entry swaps the original debits and credits, and the invoice stores its reversal entry ID.
5. **Why can aging differ from the A/R ledger?** Manual journals can change A/R without changing customer invoices; the report returns a difference instead of hiding it.

**60-second presentation:** “The sales backend keeps invoices as drafts until they are sent. It calculates each item in integer cents, then posts one balanced journal entry when sending. The invoice number is allocated atomically inside that transaction, so failed sends do not consume numbers. Payments create their own balanced entries and update the invoice amount and status together. An unpaid sent invoice can be voided only by posting a reversal. The aging report looks at invoice and payment dates as of a selected calendar date, then compares customer balances with the Accounts Receivable ledger balance. Every operation is scoped to the authenticated company.”

## 10. Three checks you can run

From the backend repository:

```bash
NODE_ENV=test npm test
rg -n "ENABLE ROW LEVEL SECURITY|CREATE TABLE IF NOT EXISTS" migrations/006_sales.sql
rg -n "calculateInvoiceItems|nextInvoiceNumber|recordPayment|voidInvoice|getArAging" src/services
```
