# Folio Backend

Folio is a Node.js and Express API backed by PostgreSQL. The ledger uses double-entry journal entries and stores money in PostgreSQL `NUMERIC(14,2)` columns.

## Requirements

- Node.js
- PostgreSQL

## Setup

Install the project dependencies:

```sh
npm install
```

Copy `.env.example` to `.env`, then set the values for your local environment:

```sh
cp .env.example .env
```

- `PORT` is the port used by the API server.
- `CLIENT_URL` is the allowed browser origin for CORS.
- `DATABASE_URL` is the PostgreSQL connection string for development.
- `DATABASE_URL_TEST` is the connection string for a **separate, disposable test database**. Never point it at development or production data.
- `JWT_SECRET` is a private signing key of at least 32 characters. Generate a unique local value, for example with `openssl rand -hex 32`. Never use the placeholder from `.env.example` outside local setup.
- `JWT_EXPIRES_IN` controls token lifetime using `jsonwebtoken` duration syntax (default example: `2h`).

The values in `.env.example` are fake examples. Replace the database URLs with your own local PostgreSQL connection strings and set a private `JWT_SECRET`. After creating the development database, apply its migrations and seed the demo company:

```sh
npm run migrate
npm run seed
```

The migration runner applies numbered SQL files once and records their names in `schema_migrations`. The seed can be run again safely; it reuses the demo company and does not duplicate its default accounts. Authentication creates its own company and default accounts during registration; no company ID needs to be configured in the environment.

## Run the API

Start the server:

```sh
npm start
```

For development with automatic restarts:

```sh
npm run dev
```

Check that the server is available:

```sh
curl http://localhost:3000/health
```

## Authentication

The API includes:

- `GET /health`
- `POST /api/auth/register` (public): create a user and company with the default Chart of Accounts.
- `POST /api/auth/login` (public): exchange credentials for a bearer token.
- `GET /api/auth/me` (requires a bearer token): return the authenticated user and company.
- `GET /api/accounts`
- `POST /api/journal-entries`
- `GET /api/journal-entries`
- `GET /api/journal-entries/:id`
- `GET /api/reports/trial-balance`
- `GET /api/reports/income-statement`
- `GET /api/reports/balance-sheet`

Every API route other than registration and login requires `Authorization: Bearer <token>`. Company scope is loaded from the authenticated user's database record.

Register a user and company:

```sh
curl -sS http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "companyName": "Example Studio",
    "fullName": "Amina Example",
    "email": "amina@example.test",
    "password": "replace-with-a-strong-password"
  }'
```

Log in and capture the token without printing it:

```sh
TOKEN="$(curl -sS http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"amina@example.test","password":"replace-with-a-strong-password"}' \
  | node -e "let body=''; process.stdin.on('data', chunk => body += chunk).on('end', () => process.stdout.write(JSON.parse(body).data.token))")"
```

Use the token to view the current user and company:

```sh
curl -sS http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

Journal-entry amounts are decimal strings with at most two decimal places. For example, use `"5000.00"`, not the JSON number `5000`.

## Run tests

Create a separate test database first. Set `DATABASE_URL_TEST` in `.env` to that database and set `NODE_ENV=test` when running tests:

```sh
NODE_ENV=test npm test
```

The test setup refuses to run unless `NODE_ENV=test`, `DATABASE_URL_TEST` is set, and it differs from `DATABASE_URL`. The integration tests apply the migrations to the test database, create and remove their own test companies, and exercise the API and database balance trigger. Do not use a development or production database as the test database.

## Sales

Sales endpoints require `Authorization: Bearer <token>`. Customer and invoice list endpoints return `{ "data": [...], "meta": { "page": 1, "limit": 20, "total": 0 } }`. Page defaults to 1 and limit defaults to 20 (maximum 100). Dates are plain `YYYY-MM-DD` strings. Amounts, quantities, unit prices, and tax rates are decimal strings to avoid floating-point arithmetic.

### Customers

- `GET /api/customers?search=<text>&active=true|false&page=1&limit=20`
- `POST /api/customers`
- `GET /api/customers/:id`
- `PATCH /api/customers/:id`

Create body: `{ "name": "Example Customer", "email": "customer@example.test", "phone": "<phone>", "address": "<address>", "paymentTermsDays": 30 }`. PATCH accepts any subset of `name`, `email`, `phone`, `address`, `paymentTermsDays`, and `isActive`. Customers are deactivated, not deleted.

### Invoices

- `GET /api/invoices?status=draft|sent|partial|paid|void&customerId=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD&number=<text>&page=1&limit=20`
- `POST /api/invoices` creates a draft.
- `GET /api/invoices/:id`
- `PATCH /api/invoices/:id` edits a draft only.
- `DELETE /api/invoices/:id` deletes a draft only (204 response).
- `POST /api/invoices/:id/send` numbers and posts a draft.
- `POST /api/invoices/:id/void` reverses an unpaid sent invoice.
- `POST /api/invoices/:id/payments` records a customer payment.

Create body (issue date defaults to today in Kuala Lumpur; due date defaults to issue date plus customer payment terms):

```json
{
  "customerId": "<customer-id>", "issueDate": "<yyyy-mm-dd>", "dueDate": "<yyyy-mm-dd>",
  "items": [{ "description": "Consulting service", "quantity": "1.00", "unitPrice": "100.00", "taxRate": "6.00", "revenueAccountId": "<active-revenue-account-id>" }],
  "notes": "<notes>"
}
```

The server rounds each line net and tax half up to cents, then adds rounded lines. For example, `1.00 × 0.25` at `6.00%` returns net `0.25`, tax `0.02`, and total `0.27`. Drafts have no invoice number. Sending assigns the next company sequence, such as `INV-0001`, and posts debit Accounts Receivable, credit revenue by account, and credit Sales Tax Payable when tax is nonzero. Payments debit an active asset deposit account and credit Accounts Receivable. Voiding creates a posted reversal; paid and partially paid invoices cannot be voided.

Invoice detail response:

```json
{
  "data": {
    "id": "<invoice-id>", "companyId": "<company-id>", "customerId": "<customer-id>",
    "invoiceNumber": "<invoice-number-or-null>", "issueDate": "<yyyy-mm-dd>", "dueDate": "<yyyy-mm-dd>",
    "status": "draft", "subtotal": "100.00", "taxTotal": "6.00", "total": "106.00", "amountPaid": "0.00",
    "notes": null, "journalEntryId": null, "reversalEntryId": null, "createdAt": "<timestamp>",
    "customer": { "id": "<customer-id>", "name": "Example Customer", "email": "<email-or-null>", "phone": "<phone-or-null>", "address": "<address-or-null>", "paymentTermsDays": 30 },
    "items": [{ "id": "<item-id>", "description": "Consulting service", "quantity": "1.00", "unitPrice": "100.00", "taxRate": "6.00", "revenueAccountId": "<account-id>", "revenueAccountCode": "4000", "revenueAccountName": "Sales Revenue", "lineSubtotal": "100.00", "lineTax": "6.00", "lineTotal": "106.00" }],
    "payments": []
  }
}
```

Payment body: `{ "paymentDate": "<yyyy-mm-dd>", "amount": "50.00", "method": "bank_transfer", "reference": "<reference-or-null>", "depositAccountId": "<active-asset-account-id>" }`. Payment success returns `{ "data": { "payment": { "id": "<payment-id>", "paymentDate": "<yyyy-mm-dd>", "amount": "50.00", "method": "bank_transfer", "reference": "<reference-or-null>", "depositAccountId": "<account-id>", "journalEntryId": "<entry-id>", "createdAt": "<timestamp>" }, "invoice": { "...": "updated invoice detail" } } }`.

### Accounts Receivable Aging

`GET /api/reports/ar-aging?asOf=YYYY-MM-DD`

`asOf` defaults to today in Kuala Lumpur time. Open invoices issued on or before the date are grouped by due date. Payments dated after `asOf` do not reduce the historical outstanding amount. Ledger balance uses the Accounts Receivable system account. `difference` is ledger balance minus aging total, so manual journal entries to A/R appear as a mismatch.

```json
{
  "data": {
    "asOf": "<yyyy-mm-dd>", "currency": "MYR",
    "customers": [{ "customerId": "<customer-id>", "name": "Example Customer", "current": "0.00", "days1To30": "100.00", "days31To60": "0.00", "days61To90": "0.00", "days90Plus": "0.00", "total": "100.00" }],
    "totals": { "current": "0.00", "days1To30": "100.00", "days31To60": "0.00", "days61To90": "0.00", "days90Plus": "0.00", "total": "100.00" },
    "ledgerBalance": "100.00", "difference": "0.00", "reconciles": true
  }
}
```

## Purchases

Purchase endpoints require `Authorization: Bearer <token>`. Vendor and bill lists return `{ "data": [...], "meta": { "page": 1, "limit": 20, "total": 0 } }`. Dates use plain `YYYY-MM-DD` strings and amounts are decimal strings with at most two places. Bill lines have no tax; the server sums the entered line amounts exactly in integer cents.

### Vendors

- `GET /api/vendors?search=<text>&active=true|false&page=1&limit=20`
- `POST /api/vendors`
- `GET /api/vendors/:id`
- `PATCH /api/vendors/:id`

Vendor fields mirror customers: `name`, `email`, `phone`, `address`, `paymentTermsDays`, and `isActive`. Payment terms default to 30 days. Vendors are deactivated rather than deleted.

### Bills

- `GET /api/bills?status=draft|open|partial|paid|void&vendorId=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD&number=<text>&page=1&limit=20`
- `POST /api/bills` creates a draft.
- `GET /api/bills/:id`
- `PATCH /api/bills/:id` edits a draft only.
- `DELETE /api/bills/:id` deletes a draft only (204 response).
- `POST /api/bills/:id/post` posts a draft to the ledger and changes status to `open`.
- `POST /api/bills/:id/void` reverses an unpaid open bill.
- `POST /api/bills/:id/payments` records a payment.

Create body:

```json
{
  "vendorId": "<vendor-id>", "billNumber": "SUP-1042",
  "issueDate": "<yyyy-mm-dd>", "dueDate": "<yyyy-mm-dd>",
  "items": [
    { "description": "Office rent", "amount": "300.00", "accountId": "<active-expense-or-asset-account-id>" }
  ],
  "notes": "<notes>"
}
```

`billNumber` is required when saving the draft and is unique per company and vendor. `issueDate` defaults to today in Kuala Lumpur time. If `dueDate` is omitted, it defaults to issue date plus the vendor's payment terms. Each item amount must be positive and its account must be an active expense or asset account in the company. Posting debits each item account and credits the Accounts Payable system-role account.

Bill detail response:

```json
{
  "data": {
    "id": "<bill-id>", "companyId": "<company-id>", "vendorId": "<vendor-id>",
    "billNumber": "SUP-1042", "issueDate": "<yyyy-mm-dd>", "dueDate": "<yyyy-mm-dd>",
    "status": "open", "total": "300.00", "amountPaid": "0.00", "notes": null,
    "journalEntryId": "<journal-entry-id>", "reversalEntryId": null, "createdAt": "<timestamp>",
    "vendor": { "id": "<vendor-id>", "name": "Example Supplier", "email": null, "phone": null, "address": null, "paymentTermsDays": 30 },
    "items": [{ "id": "<item-id>", "description": "Office rent", "amount": "300.00", "accountId": "<account-id>", "accountCode": "6000", "accountName": "Rent Expense", "accountType": "expense" }],
    "payments": []
  }
}
```

Payment body: `{ "paymentDate": "<yyyy-mm-dd>", "amount": "100.00", "method": "bank_transfer", "reference": "<reference-or-null>", "payingAccountId": "<active-asset-account-id>" }`. The server debits Accounts Payable and credits the paying asset account in the same transaction that stores the payment and updates `amountPaid`/status. Overpayments are rejected. Only unpaid `open` bills can be voided; a void creates a posted reversal and keeps the original entry immutable.

### Accounts Payable Aging

`GET /api/reports/ap-aging?asOf=YYYY-MM-DD`

`asOf` is optional and defaults to today in Kuala Lumpur time. The response groups outstanding open bills by vendor and due-date bucket. Payments after `asOf` do not reduce historical outstanding amounts. The ledger balance is the credit-normal Accounts Payable balance; `difference` is ledger balance minus aging total.

```json
{
  "data": {
    "asOf": "<yyyy-mm-dd>", "currency": "MYR",
    "vendors": [{ "vendorId": "<vendor-id>", "name": "Example Supplier", "current": "0.00", "days1To30": "100.00", "days31To60": "0.00", "days61To90": "0.00", "days90Plus": "0.00", "total": "100.00" }],
    "totals": { "current": "0.00", "days1To30": "100.00", "days31To60": "0.00", "days61To90": "0.00", "days90Plus": "0.00", "total": "100.00" },
    "ledgerBalance": "100.00", "difference": "0.00", "reconciles": true
  }
}
```


## Reports

All report endpoints require `Authorization: Bearer <token>`. Reports are calculated from posted journal lines for the authenticated user's company. Date ranges are inclusive; dates use `YYYY-MM-DD`. If a date parameter is omitted, defaults use the current date in `Asia/Kuala_Lumpur`.

### Trial Balance

`GET /api/reports/trial-balance?asOf=YYYY-MM-DD`

`asOf` is optional and defaults to today in Kuala Lumpur time. The response includes accounts with posted lines on or before the date, debit and credit totals, and a balance flag.

```json
{
  "data": {
    "asOf": "<yyyy-mm-dd>",
    "currency": "<currency>",
    "accounts": [
      {
        "accountId": "<account-id>",
        "code": "<account-code>",
        "name": "<account-name>",
        "type": "<account-type>",
        "debit": "<amount>",
        "credit": "<amount>"
      }
    ],
    "totals": { "debit": "<amount>", "credit": "<amount>" },
    "isBalanced": true
  }
}
```

### Income Statement (Profit and Loss)

`GET /api/reports/income-statement?from=YYYY-MM-DD&to=YYYY-MM-DD`

Both parameters are optional. `from` defaults to the first day of the current month in Kuala Lumpur time; `to` defaults to today. `from` must be on or before `to`.

```json
{
  "data": {
    "from": "<yyyy-mm-dd>",
    "to": "<yyyy-mm-dd>",
    "currency": "<currency>",
    "revenue": {
      "accounts": [
        {
          "accountId": "<account-id>",
          "code": "<account-code>",
          "name": "<account-name>",
          "amount": "<amount>"
        }
      ],
      "total": "<amount>"
    },
    "expenses": {
      "accounts": [
        {
          "accountId": "<account-id>",
          "code": "<account-code>",
          "name": "<account-name>",
          "amount": "<amount>"
        }
      ],
      "total": "<amount>"
    },
    "netIncome": "<amount>"
  }
}
```

### Balance Sheet

`GET /api/reports/balance-sheet?asOf=YYYY-MM-DD`

`asOf` is optional and defaults to today in Kuala Lumpur time. Current earnings are the all-time net income through `asOf`, since the system does not yet create period-closing entries.

```json
{
  "data": {
    "asOf": "<yyyy-mm-dd>",
    "currency": "<currency>",
    "assets": { "accounts": [], "total": "<amount>" },
    "liabilities": { "accounts": [], "total": "<amount>" },
    "equity": {
      "accounts": [],
      "currentEarnings": "<amount>",
      "total": "<amount>"
    },
    "totalLiabilitiesAndEquity": "<amount>",
    "isBalanced": true,
    "difference": "<amount>"
  }
}
```

Each account in the Balance Sheet's `assets`, `liabilities`, and `equity` arrays has `accountId`, `code`, `name`, and `amount` fields. Monetary response values are strings with two decimal places. Empty account lists and zero totals are returned when there are no matching posted lines.
