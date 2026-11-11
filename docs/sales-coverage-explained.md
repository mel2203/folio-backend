# Sales coverage stage: explanation

## 1. Summary

This stage completed verification coverage for the existing Sales backend and fixed two frontend request-state problems. The backend already had the Sales schema, customer and invoice endpoints, ledger posting, payment handling, invoice reversal, and A/R aging report. I added integration assertions for important API cases instead of changing those already-working backend services. In the client, a customer active-state button now shows and disables during its request, and Invoice Detail displays deposit-account loading errors instead of hiding them. No production backend service, migration, database, or package was changed by this stage. The explanation describes the implementation as it exists; it does not claim that backend integration tests passed.

## 2. One request end to end

Example: record a customer payment from the invoice detail screen.

1. The user opens an invoice with status `sent` or `partial`. The page loads the invoice and active accounts. It filters the account list to active asset accounts. If the account request fails or has the wrong response shape, the page displays the error and keeps “Record payment” disabled. See the [InvoiceDetail page](<../../Folio - Frontend/folio-frontend/src/pages/InvoiceDetail.jsx>), lines 31–49 and 138–149.
2. The payment form sends a decimal-string amount and the payment date, method, optional reference, and deposit-account ID. The frontend API helper posts to `/api/invoices/:id/payments`. See the frontend [sales API module](<../../Folio - Frontend/folio-frontend/src/api/sales.js>), lines 55–58, and [InvoiceDetail page](<../../Folio - Frontend/folio-frontend/src/pages/InvoiceDetail.jsx>), lines 77–111.
3. Express mounts invoice routes below the authenticated `/api` middleware, so the company context comes from authentication rather than the submitted JSON. See [app.js](../src/app.js), lines 31–40, and [authenticate.js](../src/middleware/authenticate.js).
4. The invoice payment route applies `paymentSchema`. It validates the invoice ID, optional calendar date, positive decimal-string amount, method, reference, and deposit account ID. See [invoice.routes.js](../src/routes/invoice.routes.js), lines 7–14, and [sales.validator.js](../src/validators/sales.validator.js), lines 143–153.
5. The controller passes `req.companyId`, validated input, and a transaction-bound database client into the service. It returns HTTP 201 with `{ data: result }`. See [invoice.controller.js](../src/controllers/invoice.controller.js), lines 50–55, and [db.js](../src/config/db.js), lines 17–40.
6. The service locks the invoice row, permits payment only on sent or partial invoices, and compares the amount with the outstanding balance in integer cents. It confirms the deposit account is an active asset owned by the company and finds A/R using its `system_role`. It posts a balanced journal entry, inserts the payment, and updates `amount_paid` and the invoice status, all in the transaction. Its SQL parameters are bound separately from the SQL text. See [invoice.service.js](../src/services/invoice.service.js), lines 321–365, and [journal.service.js](../src/services/journal.service.js), lines 40–102.
7. The success body is shaped as `{ data: { payment, invoice } }`. `payment` contains identifiers, date, decimal-string amount, method, reference, deposit account, journal-entry ID, and creation time. `invoice` is the updated invoice detail, including customer, items, and payments. The frontend request wrapper unwraps `data`, so the page receives `{ payment, invoice }`, updates its invoice state, and closes the form. See [invoice.controller.js](../src/controllers/invoice.controller.js), lines 50–55, [invoice.service.js](../src/services/invoice.service.js), lines 143–195 and 321–365, [client.js](<../../Folio - Frontend/folio-frontend/src/api/client.js>), lines 56–91, and [InvoiceDetail page](<../../Folio - Frontend/folio-frontend/src/pages/InvoiceDetail.jsx>), lines 94–111.

The service-defined response shapes have been checked in source, not observed from a live API. The backend integration suite was not run because `DATABASE_URL_TEST` was unavailable.

## 3. Journal entries created by this stage

The code changes in this stage did not add production journal-entry creation. The existing backend workflows that the new or expanded integration tests exercise can create these entries:

| Event | Debit | Credit | Worked example | Statement effect |
|---|---|---|---|---|
| Send an invoice | Accounts Receivable 0.27 | Sales Revenue 0.25; Sales Tax Payable 0.02 | One 0.25 line at 6% tax rounds half-up to 0.02 tax, total 0.27. | A/R asset increases; revenue increases profit/equity; sales-tax liability increases. |
| Record a payment | Deposit asset account 0.27 | Accounts Receivable 0.27 | Full payment of the example invoice. | Cash/bank asset increases; A/R asset decreases. |
| Void an unpaid sent invoice | Sales Revenue 0.25; Sales Tax Payable 0.02 | Accounts Receivable 0.27 | Reversal of the example invoice. | Reverses the invoice’s revenue, tax liability, and receivable effects. The original journal entry remains posted. |

These are balanced examples of the existing service logic, not additional entries created while editing. Invoice posting is in [invoice.service.js](../src/services/invoice.service.js), lines 258–319; payment posting is lines 321–365; reversal posting is lines 367–402. The integration assertions check actual 100.00 plus 6.00 tax examples and journal-line sides in [sales.integration.test.js](../tests/sales.integration.test.js), lines 217–236, 360–394, and 416–449.

## 4. Tables and columns

No table, column, or migration was added or changed by this stage. The pre-existing [006_sales.sql migration](../migrations/006_sales.sql) defines:

| Table | Purpose and notable constraints |
|---|---|
| `customers` | Company-owned contacts. Names are trimmed-length checked; payment terms cannot be negative; `is_active` supports deactivation without deletion. |
| `document_sequences` | Stores the last number per company and document kind. `(company_id, kind)` is the primary key and the sequence cannot be negative. |
| `invoices` | Stores invoice dates, status, totals, paid amount, and journal/reversal references. Status is constrained; amounts are nonnegative; paid amount cannot exceed total; invoice number is unique within a company. |
| `invoice_items` | Stores invoice descriptions, quantity, unit price, tax rate, and revenue account. Quantity must be positive; unit price nonnegative; tax rate is 0–100; deleting a draft invoice cascades to its items. |
| `payments` | Stores payment date, amount, method, deposit account, and journal-entry reference. Amount must be positive; it references an invoice and account. |

The migration enables row-level security on all five tables. It also uses foreign keys and company-oriented indexes. See [006_sales.sql](../migrations/006_sales.sql), lines 1–79. The integration-test fixture applies migrations only when the integration suite runs; no migration was run during this work.

## 5. Rules protecting the data

| Rule | Where it is enforced |
|---|---|
| Money is not calculated with floating-point decimals. | The backend parses decimal strings into `BigInt` cents and formats them back to strings in [money.js](../src/utils/money.js), lines 1–44. Invoice line and tax rounding use half-up integer arithmetic in [invoice.service.js](../src/services/invoice.service.js), lines 8–26. |
| 0.25 at 6% produces 0.02 tax. | The server rounds tax per line before summing. The focused unit test is in [invoice-rounding.test.js](../tests/invoice-rounding.test.js). |
| Company isolation. | Auth middleware derives the company context. The services include `company_id` predicates and check related customer/account company IDs; A/R aging filters invoices, customers, ledger entries, and accounts by company. Examples: [invoice.service.js](../src/services/invoice.service.js), lines 46–77 and 321–345; [ar-aging.service.js](../src/services/ar-aging.service.js), lines 6–54. |
| SQL parameters are not mixed with user input in SQL text. | Service queries pass values as parameter arrays. In invoice filtering, the column names are selected from a fixed internal list and filter values are bound; see [invoice.service.js](../src/services/invoice.service.js), lines 106–141. |
| Invoices are editable/deletable only as drafts. | The service locks the row and checks its status before update/delete. The DELETE affects the invoice document, not a journal entry. See [invoice.service.js](../src/services/invoice.service.js), lines 205–244. |
| Journal entries are not updated or deleted to correct a posted invoice. | Void creates a posted reversal with swapped debit/credit amounts and a `reversesEntryId`; it only updates the invoice’s status and reversal reference. See [invoice.service.js](../src/services/invoice.service.js), lines 367–402. |
| Invoice number assignment is atomic. | `nextInvoiceNumber` increments a company/document sequence with `INSERT ... ON CONFLICT ... DO UPDATE` inside the send transaction. See [invoice.service.js](../src/services/invoice.service.js), lines 246–256 and 258–319. |
| A/R aging reconciles against the ledger. | The report computes aging totals and the posted A/R account balance, then returns `difference` and `reconciles`. See [ar-aging.service.js](../src/services/ar-aging.service.js), lines 3–71, and [aging.js](../src/utils/aging.js), lines 5–43. |
| Tenant table protection. | The existing migration enables RLS on each Sales table. Application query scoping is still explicit; the tests do not prove RLS policies (none are defined in this migration). See [006_sales.sql](../migrations/006_sales.sql), lines 14, 22, 48, 61, and 79. |

## 6. Tests: what they prove and what is not tested

The backend integration additions cover customer editing, no customer DELETE route, cross-company reads, invoice detail and list filters, concurrent numbering, journal line contents, payment state transitions, overpayment, foreign-company accounts, reversal behavior, A/R aging boundaries and tenant isolation, malformed dates, and excess decimal precision. Relevant cases are in [sales.integration.test.js](../tests/sales.integration.test.js), lines 140–176, 197–236, 259–342, 343–449, and 505–601.

The frontend regression tests prove that the customer active-state action disables while its request is pending and that a deposit-account request failure is announced while “Record payment” remains disabled. They are in [customers.test.jsx](<../../Folio - Frontend/folio-frontend/tests/customers.test.jsx>), lines 26–54, and [invoice-detail.test.jsx](<../../Folio - Frontend/folio-frontend/tests/invoice-detail.test.jsx>), lines 46–73.

Verification actually completed:

- Frontend focused tests: 2 files passed, 8 tests passed.
- ESLint on the four affected frontend source/test files: passed.
- Backend invoice-rounding unit test: 1 suite passed, 1 test passed.
- Backend syntax checks and `git diff --check`: passed.
- Backend Sales integration suite: **not run**. `DATABASE_URL_TEST` was not available. Therefore the added database-backed assertions have not been verified by execution.

The integration suite also contains tests that predate this work. Passing one test or a syntax check does not prove that the full suite passes, that a live API has been exercised, or that production data is safe.

## 7. How to try it

Frontend checks, from the frontend repository:

```sh
npm test -- tests/invoice-detail.test.jsx tests/customers.test.jsx
./node_modules/.bin/eslint src/pages/InvoiceDetail.jsx tests/invoice-detail.test.jsx src/pages/ContactDirectoryPage.jsx tests/customers.test.jsx
```

Backend Sales integration tests must be run from the backend repository with a test-only database URL:

```sh
NODE_ENV=test DATABASE_URL_TEST='<TEST-ONLY-DATABASE-URL>' npm test -- --runTestsByPath tests/sales.integration.test.js
```

The test guard requires `NODE_ENV=test`, requires `DATABASE_URL_TEST`, and rejects it if it equals `DATABASE_URL`; see [test-environment.js](../tests/test-environment.js), lines 1–15. The integration setup applies migrations to its configured test database. Do not substitute a development or production URL. This command is instructions for a future test run; I did not run it.

Manual UI checks, with the frontend and backend already running:

1. Sign in, open Customers, and press Deactivate for a customer. While the request is pending, the button should read “Deactivating...” and be disabled.
2. Open a sent or partially paid invoice. If active deposit accounts load, Record payment can open the form. If accounts cannot load, an alert explains the failure and the action remains disabled.
3. Record a valid payment using an active asset account. The page should show the updated paid amount/status returned by the API.

## 8. Decisions, trade-offs, and limitations

- Not built in this stage: new Sales endpoints, new accounting behavior, new schema, client-side accounting calculations, or a retry button for deposit-account loading.
- Backend features were already implemented, so this stage concentrated on missing verification coverage rather than changing completed business logic.
- The new customer pending state prevents repeated active-state submissions while a request is outstanding.
- The deposit-account failure is no longer swallowed. The message asks the user to reload; no retry control was added.
- Backend response shapes were inferred from the checked-in controller/service code, not observed from a running server.
- Database-backed integration tests remain unverified until run with a dedicated test database.
- The backend worktree had pre-existing uncommitted changes in `src/services/ar-aging.service.js` and `tests/sales.integration.test.js`; those were preserved. The A/R aging service change was not authored as part of this stage.
- No production backend service or migration was altered, no packages were added, and no `.env` file was opened, printed, or edited.

## 9. Examiner questions and a short presentation


**Q1. Why store money as decimal strings and use integer cents?**

The API and database use two-decimal amounts. Integer cents avoid binary floating-point rounding errors. The service converts back to decimal strings for storage and responses.

**Q2. How is an invoice number protected against two sends at once?**

The service increments one `(company_id, kind)` row using an atomic upsert inside the same transaction that posts the invoice.

**Q3. Why does void create another entry instead of changing the old one?**

A posted journal entry is immutable. A reversal swaps its debit and credit lines, preserving the audit trail while cancelling its accounting effect.

**Q4. How does a payment change the ledger?**

The service debits the selected deposit asset and credits A/R, then updates the invoice’s paid amount and status in the same transaction.

**Q5. What does `reconciles` mean in A/R aging?**

It indicates whether the sum of open invoices in the aging report equals the posted A/R ledger balance as of the report date.

**60-second presentation:**

“The Sales backend already had customers, invoices, payments, posting, void reversals, and A/R aging. I added integration coverage for gaps such as concurrent invoice numbering, tenant isolation, payment and reversal journal lines, aging boundaries, and invalid money precision. I also fixed two client request-state problems: customer status actions now disable while saving, and Invoice Detail shows deposit-account load errors instead of silently ignoring them. The accounting service uses integer cents and the ledger remains the accounting source of truth. The frontend regression tests and lint passed. The backend database integration suite still needs to be run against a dedicated test database; I did not run migrations or connect to a database during this work.”

## 10. Three ways to check these claims

Run these from the stated repositories:

```sh
# Backend: find the posting, payment, and reversal service paths.
rg -n "async function (sendInvoice|recordPayment|voidInvoice)|postJournalEntry|nextInvoiceNumber" src/services/invoice.service.js

# Backend: run only with a dedicated TEST database URL.
NODE_ENV=test DATABASE_URL_TEST='<TEST-ONLY-DATABASE-URL>' npm test -- --runTestsByPath tests/sales.integration.test.js

# Frontend: rerun the focused regression tests.
npm test -- tests/invoice-detail.test.jsx tests/customers.test.jsx
```
