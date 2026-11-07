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
- `DEV_COMPANY_ID` is set after seeding. The development company context uses it until authentication is added.

The values in `.env.example` are fake examples. Replace the database URLs with your own local PostgreSQL connection strings. After creating the development database, apply its migrations and seed the demo company:

```sh
npm run migrate
npm run seed
```

`npm run seed` prints the demo company UUID. Put that UUID in `.env` as `DEV_COMPANY_ID`.

The migration runner applies numbered SQL files once and records their names in `schema_migrations`. The seed can be run again safely; it reuses the demo company and does not duplicate its default accounts.

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

The API includes:

- `GET /health`
- `GET /api/accounts`
- `POST /api/journal-entries`
- `GET /api/journal-entries`
- `GET /api/journal-entries/:id`

Journal-entry amounts are decimal strings with at most two decimal places. For example, use `"5000.00"`, not the JSON number `5000`.

## Run tests

Create a separate test database first. Set `DATABASE_URL_TEST` in `.env` to that database and set `NODE_ENV=test` when running tests:

```sh
NODE_ENV=test npm test
```

The test setup refuses to run unless `NODE_ENV=test`, `DATABASE_URL_TEST` is set, and it differs from `DATABASE_URL`. The integration tests apply the migrations to the test database, create and remove their own test companies, and exercise the API and database balance trigger. Do not use a development or production database as the test database.
