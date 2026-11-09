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
