# Stage 4: Demo seeder explanation

## 1. Summary

The backend now has a `seed:demo` command that reads its login credentials from `DEMO_EMAIL` and `DEMO_PASSWORD`, creates the demo user through the existing registration service, and creates three months of sample customers, vendors, invoices, bills, payments, and journal entries through existing services. The activity transaction is atomic: if one operation fails, the activity transaction rolls back. The script does not add or change database tables. It was not run against any database. The database's invoice statuses do not include `overdue`; the four overdue examples are sent invoices whose due dates are in the past.

## 2. One run from command to result

This item is a command-line seeder, not an HTTP endpoint, so there is no route, API client page, or curl request in this flow. The `seed:demo` npm command invokes [`scripts/seed-demo.js`](../scripts/seed-demo.js#L333). The script checks its arguments and environment variables, finds any existing user by the normalized demo email, and refuses to overwrite a company unless `--reset` was provided. Reset additionally requires the company and user's full name to match the demo markers before deleting company-scoped data ([`scripts/seed-demo.js`](../scripts/seed-demo.js#L102), [`scripts/seed-demo.js`](../scripts/seed-demo.js#L300)).

When no existing demo user is found, the script calls [`register`](../src/services/auth.service.js#L15), which creates the company, hashes the password, creates the user, and seeds the default accounts. It then uses [`createCustomer`](../src/services/customer.service.js#L5) and [`createVendor`](../src/services/vendor.service.js#L5), plus the invoice, bill, payment, and journal services. The ledger-writing functions are in [`invoice.service.js`](../src/services/invoice.service.js#L87), [`bill.service.js`](../src/services/bill.service.js#L77), and [`journal.service.js`](../src/services/journal.service.js#L40). Activity is run in one transaction using [`withTransaction`](../src/config/db.js#L17).

The script prints the database hostname and a generic success or failure message. It does not print the database URL, demo email, or password.

## 3. Journal entries created

The figures below are examples from the fixed seed inputs. Invoice tax and totals are calculated by the existing invoice service; no journal entry is made for an invoice draft.

| Event | Debit account | Credit account | Example | Statement effect |
|---|---|---|---|---|
| Initial owner contribution | Cash and Bank | Owner's Capital | RM 30,000.00 | Balance sheet: cash and equity increase. |
| Sending an invoice | Accounts Receivable | Sales Revenue; Sales Tax Payable when tax is positive | RM 850.00 service, RM 51.00 tax, RM 901.00 receivable | Balance sheet: receivable and tax liability increase. Income statement: revenue increases by RM 850.00. |
| Customer payment | Cash and Bank | Accounts Receivable | Full or half of the invoice total; e.g. RM 901.00 or RM 450.50 | Balance sheet: cash increases and receivable decreases. It does not create revenue a second time. |
| Posting a bill | The expense account for the bill | Accounts Payable | RM 3,500.00 monthly rent | Balance sheet: payable increases. Income statement: the expense increases. |
| Paying a bill | Accounts Payable | Cash and Bank | Full or half of the bill total; e.g. RM 465.00 or RM 232.50 for utilities | Balance sheet: cash and payable decrease. It does not record the expense a second time. |

These are entry types and worked examples, not output from a live database run. The existing journal service validates that each entry has at least two lines and equal integer-cent debits and credits.

## 4. Tables and columns

No tables or columns were added or changed. The seeder uses the existing company, user, account, customer, vendor, invoice, invoice-item, payment, bill, bill-item, bill-payment, journal-entry, journal-line, and document-sequence tables. Their definitions are in the existing migrations, including [`001_core_ledger.sql`](../migrations/001_core_ledger.sql), [`003_users.sql`](../migrations/003_users.sql), [`006_sales.sql`](../migrations/006_sales.sql), and [`007_purchases.sql`](../migrations/007_purchases.sql).

## 5. Data protections

| Rule | Enforcement |
|---|---|
| Credentials are environment-only | The script reads `DEMO_EMAIL` and `DEMO_PASSWORD` from `process.env`; it does not print either value. |
| Parameterized SQL | The lookup and reset queries use `$1` parameters. Query text is static. |
| Company isolation | Reset deletes use the matched `companyId`; bill-payment and journal-line deletes join through company-scoped bills or entries. |
| Cautious reset | `--reset` is required when the email already exists. Before deletion, both the company name and user full name must match the demo markers. |
| Balanced accounting | Journal entries go through the existing posting service; invoice and bill posting use their existing services and system-role accounts. |
| Money precision | Money inputs are decimal strings. Partial payments use `BigInt` cents through the shared money helpers; no floating-point arithmetic is used. |
| Transaction behavior | All seeded activity after registration is in one transaction. Reset is also transactional. Registration itself uses its own service transaction. |
| Existing table security | The script changes no schema or row-level-security settings. Existing table RLS is defined in the migrations. |

## 6. Tests and what is not tested

The focused command run for the existing dashboard and money tests reported **2 suites passed, 4 tests passed**:

- [`dashboard.service.test.js`](../tests/dashboard.service.test.js) checks company-scoped dashboard aggregation, aging-service integration, empty-company output, date defaulting, and invalid-date rejection.
- [`invoice-rounding.test.js`](../tests/invoice-rounding.test.js) checks line-level half-up rounding, including RM 0.25 at 6% tax producing RM 0.02 tax.

The seeder's pure date and payment helpers were also checked with Node assertions without opening a database connection. Syntax checking and `git diff --check` succeeded. The database-backed dashboard integration tests, the seeder's full service workflow, and the reset deletion path were not run. No seed, migration, or database integration command was executed.

## 7. How to try it safely

There are no UI clicks or HTTP calls for this backend-only utility. To run it yourself, first point `DATABASE_URL` at an isolated test database and provide credentials through the shell environment, not a committed file:

```sh
cd "Folio - Backend"
DATABASE_URL="$DATABASE_URL_TEST" \
DEMO_EMAIL="$DEMO_EMAIL" \
DEMO_PASSWORD="$DEMO_PASSWORD" \
npm run seed:demo
```

For a company created by this script, `npm run seed:demo -- --reset` removes that company's data and recreates it. Do not run that command against a real or production database. A successful run prints the database hostname and a completion message; the command was not run as part of this work.

## 8. Decisions, trade-offs, and limitations

- The existing registration and accounting services are reused so the script follows the same hashing, validation, posting, and balancing paths as normal application operations.
- `--reset` protects unrelated companies by requiring the demo email and both demo markers. If someone changes either marker, reset refuses rather than risking deletion.
- Registration commits before the activity transaction. If activity creation fails, the company and user remain, but the activity transaction rolls back. A later run requires `--reset`.
- The default chart contains rent, utilities, salaries, and office-supplies expense accounts. The script stops if those named accounts are absent. Overdue invoices remain in the valid `sent` state because the existing schema has no `overdue` state; aging is represented by their due dates.
- The database workflow and reset path remain unverified until run by the user against an isolated database.

## 9. Examiner questions and short answers

1. **Why does sending an invoice create revenue, but receiving a payment does not?** Sending posts the sale to revenue and receivables. Payment only moves value from receivables to cash.
2. **How is the invoice tax amount calculated?** The existing invoice service rounds tax per line using integer-cent arithmetic before summing the lines.
3. **Why does the script use account roles?** It finds cash and the default sales-revenue account through the chart's system role where available, so posting uses the server's accounting setup rather than a user-supplied account ID.
4. **How does `--reset` avoid deleting another company?** It finds the company via the supplied demo email, requires the explicit flag, and verifies both the fixed demo company and user markers before deleting rows filtered to that company.
5. **What happens if one bill payment fails halfway through seeding?** The activity transaction rolls back, so none of that run's activity remains; the separately registered company and user remain.

**60-second presentation:** “This command creates a demo company without inventing a separate accounting path. Registration calls the normal authentication service, which hashes the password and creates the starter chart. Customers and vendors use the contact services. Invoices and bills are posted through the existing sales and purchase services, and those services create balanced journal entries. Payments reduce receivables or payables rather than recording revenue or expenses twice. Partial amounts use integer cents. The sample includes paid, partial, overdue, sent, and draft invoices, plus bills for rent, utilities, salaries, and supplies. Reset is explicit and limited to the company found by the demo email after verifying the demo markers. I did not run it against a database.”

## 10. Checks you can run

From the backend repository:

```sh
node --check scripts/seed-demo.js
npm test -- --runTestsByPath tests/dashboard.service.test.js tests/invoice-rounding.test.js
rg -n "DELETE FROM|withTransaction|register|sendInvoice|recordPayment|postBill|recordBillPayment" scripts/seed-demo.js
```

The test command above covers the dashboard unit tests and invoice rounding. It does not run the demo seeder or connect to a database.
