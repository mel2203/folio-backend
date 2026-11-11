# Stage 4: dashboard API explanation

## 1. Summary

This backend item adds authenticated, read-only `GET /api/dashboard/summary`. It returns company cash, A/R and A/P outstanding, this month’s net income, six months of revenue and expenses, overdue invoice totals, the five largest customers by posted invoice receivables this year, and the five largest expense accounts this month. Cash, trends, overdue totals and rankings come from company-scoped SQL over posted journal lines or the existing document-aging logic. SQL returns money as strings; the service normalizes aggregate values through integer-cent helpers. No journal entry, table, column, migration, seed script, or frontend screen was added in this item. The frontend is not built yet. The unit tests passed; the database-backed integration scenarios are not verified because no test database URL is configured.

## 2. One request end to end

Example request: `GET /api/dashboard/summary?asOf=2026-11-11`.

1. The authenticated API middleware runs before dashboard routes. The dashboard route is mounted under `/api/dashboard` in [app.js](../src/app.js), lines 31–39.
2. The route maps `GET /summary` to the controller and validates the query with `dashboardSummarySchema` in [dashboard.routes.js](../src/routes/dashboard.routes.js), lines 1–9.
3. The schema accepts an optional valid `YYYY-MM-DD` date and defaults it to the current date in `Asia/Kuala_Lumpur`. It rejects extra query fields. See [dashboard.validator.js](../src/validators/dashboard.validator.js), lines 1–13, and the shared date schema in [report.validator.js](../src/validators/report.validator.js), lines 1–13.
4. The thin controller passes the authenticated `req.companyId` and validated date to the service, then wraps its result in `{ data }`. See [dashboard.controller.js](../src/controllers/dashboard.controller.js), lines 1–9.
5. [dashboard.service.js](../src/services/dashboard.service.js), lines 5–167, executes parameterized SQL with company ID and date parameters. The SQL filters journal entries to the authenticated company and `posted` status. It calculates cash by the `cash` system role, monthly revenue/expenses, overdue invoice count and amount, top customer invoiced amounts, and top expense accounts. The service calls the existing [A/R aging service](../src/services/ar-aging.service.js) and [A/P aging service](../src/services/ap-aging.service.js) for outstanding balances.
6. The service converts aggregate decimal strings to cents and back through [money.js](../src/utils/money.js), lines 1–44. Net income uses integer cents. The controller returns HTTP 200 with the result.
7. There is no dashboard client page yet. The frontend must be implemented after the backend response shape is reviewed and approved. This endpoint shape is read from the checked-in source; it has not been observed from a live API.

The source-defined response is:

```json
{
  "data": {
    "asOf": "2026-11-11",
    "currency": "MYR",
    "balances": {
      "cash": "1025.00",
      "accountsReceivable": "81.00",
      "accountsPayable": "40.00"
    },
    "netIncomeThisMonth": "60.00",
    "monthlyPerformance": [
      { "month": "2026-06", "revenue": "0.00", "expenses": "0.00" }
    ],
    "overdueInvoices": { "count": 1, "amount": "81.00" },
    "topCustomers": [
      { "customerId": "customer-id", "name": "Northstar Studio", "invoicedAmount": "106.00" }
    ],
    "topExpenseAccounts": [
      { "accountId": "account-id", "code": "6000", "name": "Rent Expense", "amount": "40.00" }
    ]
  }
}
```

The example shows one trend row for brevity. The actual `monthlyPerformance` list contains six rows ending with the month containing `asOf`. All money fields are two-decimal strings. The displayed IDs and values are illustrative, not live API output.

## 3. Journal entries created

This endpoint is a `GET` report and creates no journal entries.

| Event | Debit account | Credit account | Example amount | Statement effect |
|---|---|---|---|---|
| Dashboard summary request | None | None | None | None. The endpoint reads posted journal lines and document aging; it does not change any statement. |

## 4. Tables and columns

No table or column was added or changed. The service reads the existing `companies`, `accounts`, `journal_entries`, `journal_lines`, `invoices`, `payments`, `customers`, `bills`, `bill_payments`, and `vendors` data through its aggregate query and existing aging services. No migration was run.

## 5. Rules that protect the data

| Rule | Enforcement |
|---|---|
| Only the signed-in company is reported. | Controller uses `req.companyId`; SQL binds it as `$1` and scopes cash, trends, overdue invoices, customers, and expenses. A/R and A/P services also take the same company ID. |
| Only posted journal activity contributes to ledger figures. | Aggregate query checks `entry.status = 'posted'` and clips entries to `asOf`. |
| Cash is found by system role, not an editable account code. | The cash query filters `account.system_role = 'cash'`. |
| Invoice and bill balances use established aging rules. | The service calls the existing A/R and A/P aging functions instead of maintaining separate balance logic. |
| Dates are valid plain calendar dates. | `dateSchema` validates real `YYYY-MM-DD` dates; the dashboard validator defaults to the Kuala Lumpur date helper. |
| Money avoids floating-point arithmetic. | SQL aggregates numeric journal values. The service converts values to `BigInt` cents and formats two-decimal strings with the existing money helpers. It does not use `Number`, `parseFloat`, or `toFixed` for amounts. |
| The report does not write business data. | The dashboard service performs a parameterized `SELECT` and calls read-only aging services. It does not create, update, or delete entries. |
| Errors remain visible to the normal API error handler. | The route uses the repository validation middleware and the controller does not catch and suppress service errors. |

## 6. Tests and limits

- [dashboard.service.test.js](../tests/dashboard.service.test.js), lines 19–56: checks the mapped values for a representative dashboard, passes the same company/date to both aging services, and confirms the aggregate query uses the cash system role and posted entries.
- [dashboard.service.test.js](../tests/dashboard.service.test.js), lines 59–92: checks a zero-valued summary shape with six month rows and empty leaderboards.
- [dashboard.service.test.js](../tests/dashboard.service.test.js), lines 95–103: checks the Kuala Lumpur date default and invalid calendar date rejection.
- [dashboard.integration.test.js](../tests/dashboard.integration.test.js), lines 140–174: creates balanced capital, invoice/payment, and bill activity through the API and asserts the resulting dashboard figures.
- [dashboard.integration.test.js](../tests/dashboard.integration.test.js), lines 176–193: checks that one company’s posted cash is not visible to another company.
- [dashboard.integration.test.js](../tests/dashboard.integration.test.js), lines 195–210: checks an empty company response.
- [dashboard.integration.test.js](../tests/dashboard.integration.test.js), lines 212–223: checks invalid-date and unauthenticated responses.

Actual verification:

- `NODE_ENV=test DATABASE_URL_TEST='postgres://localhost:5432/folio_test' npm test -- --runTestsByPath tests/dashboard.service.test.js`: **1 suite passed, 3 tests passed**. This isolated suite uses mocks and does not connect to that URL.
- JavaScript syntax checks for the changed backend source and test files: passed.
- `git diff --check`: passed.
- Dashboard integration tests: **not run**. `DATABASE_URL_TEST` is not configured in this environment. Their expected database-backed results are not verified.
- No migration, seed, demo script, or database command was run. No `.env` file was opened, printed, or edited.

## 7. How to try it

Once the backend is running and a user has signed in, request a dashboard:

```sh
curl -H "Authorization: Bearer <ACCESS-TOKEN>" \
  "http://localhost:3000/api/dashboard/summary?asOf=2026-11-11"
```

The expected response is HTTP 200 with the `{ "data": ... }` shape above. To use the default date, omit `?asOf=...`. Invalid dates should return HTTP 400; a missing or invalid token should return HTTP 401.

To run the database-backed tests, use a dedicated test database URL from the backend repository:

```sh
NODE_ENV=test DATABASE_URL_TEST='<TEST-ONLY-DATABASE-URL>' npm test -- --runTestsByPath tests/dashboard.integration.test.js
```

The integration test setup applies the existing migrations to that configured test database. Do not substitute a development or production database URL. This command has not been run here.

## 8. Decisions, trade-offs, and limitations

- The response groups cash, A/R, and A/P under `balances`, and uses separate arrays for monthly performance, top customers, and top expense accounts. The frontend should consume these exact names and amounts.
- The aging functions are reused so the dashboard does not invent a second definition of A/R or A/P.
- The six monthly values include the month containing `asOf`; if `asOf` is mid-month, that month is partial through that date.
- Top customers are ranked by the posted A/R debit of their invoices in the year through `asOf`, so the invoiced amount includes applicable sales tax. The ranking is gross invoiced value, not remaining receivable.
- Overdue invoice amounts are measured as-of the date, subtracting payments dated on or before that date and excluding a reversal posted on or before that date.
- Not built in this item: demo seeding, frontend dashboard, charts, loading states, the broader polish list, README updates, or screenshots. These remain future items in Stage 4.
- The database-backed SQL and integration scenarios are not verified until run against a dedicated test database.

## 9. Examiner questions and a short presentation

**Q1. Why use the existing aging services for A/R and A/P?**

They already define how open invoices and bills are grouped and reconciled. Reusing them keeps dashboard balances consistent with the aging reports.

**Q2. How is cash determined if someone changes an account code?**

The query finds the cash account by `system_role = 'cash'`, not by code.

**Q3. Why does the dashboard require an `asOf` date?**

It makes balances and historical trends repeatable. If omitted, the validator supplies today in Kuala Lumpur.

**Q4. How is net income calculated without floating-point values?**

Revenue and expense totals are converted to integer cents. The service subtracts cents and formats the result as a two-decimal string.

**Q5. Does this GET request post anything to the ledger?**

No. It reads posted ledger lines and document balances. It performs no journal-entry writes.

**60-second presentation:**

“I added an authenticated dashboard summary endpoint. It takes an optional as-of date and defaults to today in Kuala Lumpur. The service gets cash from the cash system role, uses the existing aging services for receivables and payables, and aggregates posted journal lines for the six-month trend and expense ranking. It also calculates overdue invoices and ranks customers by their posted receivables this year. Money is returned as decimal strings and normalized using integer cents. The endpoint is read-only. The three isolated unit tests passed. The database integration tests are written but not verified because I do not have a test database URL in this environment.”

## 10. Three ways to check these claims

From the backend repository:

```sh
# Inspect route and controller wiring.
rg -n "dashboardRoutes|router.get|async function summary" src/app.js src/routes/dashboard.routes.js src/controllers/dashboard.controller.js

# Inspect company scope, posted-only conditions, system role, and aging calls.
rg -n "company_id = \\$1|status = 'posted'|system_role = 'cash'|getArAging|getApAging" src/services/dashboard.service.js

# Run the isolated tests without a database connection.
NODE_ENV=test DATABASE_URL_TEST='postgres://localhost:5432/folio_test' npm test -- --runTestsByPath tests/dashboard.service.test.js
```
