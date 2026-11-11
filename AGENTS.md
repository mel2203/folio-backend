## Project context

Folio is a double-entry accounting and invoicing web app for small businesses in Malaysia (currency MYR). This repository is the **backend**: a Node.js and Express REST API with PostgreSQL (Supabase). The React frontend lives in the separate repository `folio-client`.

## Scope of edits

- By default, edit only this repository.
- When a task explicitly says it spans both repositories, you may also edit `folio-client`, but keep the changes separate per repository, do the backend first, and report the final API response shapes before the client is changed.

Folder structure
index.js starts the server (listen only)
src/app.js builds and exports the Express app (no listen)
src/config/db.js pg Pool and a transaction helper
src/routes/ route definitions only
src/controllers/ read the request, call a service, send the response
src/services/ business logic and SQL
src/validators/ zod schemas
src/middleware/ error handler, validation, request context
src/utils/money.js money helpers
src/errors.js custom error classes
migrations/ numbered .sql files
scripts/ migrate.js and seed.js
tests/ jest tests
Keep controllers thin and put logic in services. Do not put SQL in controllers or routes.

Accounting rules (must never be broken)

1. Every journal entry has at least two lines.
2. Total debits must equal total credits for every entry.
3. A line has either a debit or a credit greater than zero, never both and never neither.
4. Account balances are never stored. They are always calculated from journal_lines.
5. Posted entries are immutable. Never write an UPDATE or DELETE endpoint for journal entries or lines. Corrections are made with a reversing entry (added in a later phase).
6. Account types and normal balances: asset and expense are debit-normal; liability, equity and revenue are credit-normal.

Money rules
• Money is NUMERIC(14,2) in the database.
• pg returns NUMERIC as a string. Never convert money to floating point numbers or do arithmetic with parseFloat, Number or + on decimals.
• Do money arithmetic in integer cents (use BigInt or integers) through helpers in src/utils/money.js, and convert back to a two-decimal string for storage and responses.
• Reject amounts with more than two decimal places.
Security and data rules
• Use parameterised queries only ($1, $2). Never build SQL with string concatenation or template literals containing user input.
• Every query on business data must filter by company_id. The company id comes from req.companyId, never from the request body or URL.
• Never log passwords, tokens, connection strings or secrets.
• Never hardcode secrets or credentials. Read them from process.env.
• Never commit .env. Keep .env.example updated with every new variable (fake values only).
• Never return stack traces, SQL text or database error details to the client.
API conventions
• JSON only. Success: { "data": ... }. Errors: { "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }.
• Status codes: 200 OK, 201 Created, 400 malformed request, 404 not found, 422 failed business rule (such as unbalanced entry), 500 unexpected error.
• Pagination for lists: page (default 1) and limit (default 20, maximum 100). Return { data, meta: { page, limit, total } }.
• Dates use YYYY-MM-DD.
• Use async/await with a single central error-handling middleware. Do not swallow errors.
Database rules
• Schema changes go in new numbered migration files. Never edit a migration that has already been run.
• Any operation that writes more than one row must run in a single database transaction (BEGIN, COMMIT, ROLLBACK on error, always release the client).
• Never run DROP, TRUNCATE or DELETE without a WHERE clause outside of the test setup helper.
Testing rules
• Tests must never run against the real development or production database. Use DATABASE_URL_TEST. Tests must refuse to run if NODE_ENV is not test or if DATABASE_URL_TEST is missing or equal to DATABASE_URL.
• Every new service function and endpoint needs tests for the success case and for at least two failure cases.
How to work
• Do only what the current task asks. Do not build features from later phases (authentication, invoices, bills, payments, reports, a frontend).
• Work in small steps. After each step, say what you did and what to run to verify it.
• If a requirement is unclear or conflicts with these rules, stop and ask instead of guessing.
• Do not modify files outside this repository, .gitignore, or .env. Do not delete existing files.
• Write simple, readable code with short comments explaining accounting logic, because a student must be able to explain it in a presentation.
• Prefer clear names over clever code. No unused code, no console logs left behind.

Add a new section: Authentication and authorisation rules
• Passwords are hashed with bcryptjs using a cost factor of 12. Never store, log, return or compare plaintext passwords. Never return password_hash in any response. Select explicit columns; do not use SELECT \* on the users table.
• Tokens are JWTs signed with JWT_SECRET using HS256. Always pass algorithms: ['HS256'] when verifying, so tokens using none or other algorithms are rejected.
• JWT_SECRET must be at least 32 characters. The app must refuse to start if it is missing or too short. Never log it, hard-code it or put a real value in .env.example.
• The company for a request comes only from the authenticated user's row in the database, loaded by the authenticated middleware. Never from the request body, URL, query string or a client-supplied header.
• Login errors must be identical for an unknown email and a wrong password ("Invalid email or password") and must take similar time (compare against a dummy hash when the user does not exist).
• Auth endpoints are rate limited. Rate limiting is disabled only when NODE_ENV is test.
• Error responses for authentication failures use status 401 with code UNAUTHENTICATED and never say why a token failed in detail.
• Every route except GET /health, POST /api/auth/register and POST /api/auth/login requires a valid token.

Working across two repositories
• The backend (folio-server) and frontend (folio-client) are separate Git repositories with separate branches and pull requests. Keep changes separate per repo and commit them separately.
• When a task needs both, do the backend first, run its tests, then report the exact API response shapes before touching the client. The client must adapt to the server's real responses and never guess field names.
• Never open, read, print or edit any .env file. Never print secrets, tokens, passwords or connection strings.
• Never run anything that modifies my real database. Tests run only against DATABASE_URL_TEST. This stage needs no migrations and no schema changes.
• Do not add packages without asking first and explaining why.
• Do not edit tests only to make them pass. Fix the code.
• Show a numbered plan and wait for my approval before editing. Work in stages and stop after each one.
Reporting rules (backend)
• Reports are calculated from journal_lines on every request and never stored. Never add balance columns or report tables.
• Only entries with status posted count. Every query is scoped by company_id from req.companyId (never from the request) and uses parameterised SQL only.
• Reports are read-only: GET endpoints only. No UPDATE, DELETE or INSERT.
• Sum money in SQL with NUMERIC and return amounts as strings with two decimals. Any arithmetic in JavaScript (totals, differences) uses the integer-cents helpers in src/utils/money.js. No parseFloat, no Number() on money, no toFixed.
• Sign conventions: asset and expense accounts are debit-normal (balance = debits minus credits); liability, equity and revenue accounts are credit-normal (balance = credits minus debits). A negative balance means the account is on its opposite side.
• Dates are YYYY-MM-DD strings. Date parameters are validated with zod; from and to are inclusive and from must not be after to.
• Error format, status codes and authentication middleware stay as they are.

Explain-what-you-built protocol (mandatory after every stage)
After finishing a stage, and whenever I say "explain", write an explanation for an accounting student who knows the accounting but is still learning the code. Rules:
• Plain English. Define any technical word the first time. Short sentences.
• Only describe what is actually in the repository. Cite real file paths and line ranges. Quote code only from the repo, at most 15 lines per excerpt. Never invent code, outputs or test results.
• Say "not verified" for anything you did not run. Never claim a test passed unless you ran it and show the real summary line.
• Separate what the code does from what you intended. List what was not built.
• Cover, in this order: (1) a one-paragraph summary; (2) one real request followed end to end (route, validator, controller, service, SQL, response, client page) with file paths; (3) a table of every journal entry the stage creates (event, debit account, credit account, worked example amount) and which statements it changes; (4) new tables and columns with purpose and constraints; (5) the rules that protect the data (validation, status rules, immutability, rounding, tenant isolation) and where each is enforced; (6) what each test proves, and what is not tested; (7) how to try it: exact clicks, curl or Postman steps and the expected results; (8) decisions, trade-offs and limitations; (9) five questions an examiner might ask with short answers grounded in the code, plus a 60-second presentation script; (10) three commands or greps I can run to check your claims myself.
• Save it as docs/<stage-name>-explained.md in the repo I name, and also show a short summary in chat.
Accounting document rules
• Documents (invoices, bills, payments) are sources; the ledger is the truth. Posting a document creates one balanced journal entry through the existing postJournalEntry service, in the same database transaction as the document change.
• Journal entries and lines are never updated or deleted. A posted document is corrected by a reversing entry (swap debits and credits, source_type = 'reversal', reverses_entry_id set). Do not mark the original entry void: the original and its reversal both stay posted and net to zero, otherwise reports would remove it twice.
• Only draft documents may be edited or hard-deleted, because they are not in the ledger yet.
• Auto-posting finds accounts by system_role (not by code, because users can edit codes). Roles: cash, accounts_receivable, accounts_payable, sales_tax_payable, sales_revenue.
• Money: integer cents everywhere in code (BigInt), NUMERIC(14,2) in the database, two-decimal strings in the API. Rounding is half up, per line, then totals are sums of the rounded lines. The server computes all totals; the client sends only quantities, prices and rates.
• Dates are plain YYYY-MM-DD; do date arithmetic without timezone conversion.
• Every query is scoped by company_id from req.companyId. Every referenced id (customer, vendor, account, invoice) must be checked to belong to the same company.
Migration rules (they run on production automatically)
• New numbered files only; never edit a migration that has run. Migrations must be additive and safe to re-run on an existing database with data. Enable row level security on every new table in the same migration (no policies).
• Test every migration on the test database before merging. Never run migrations, seed or demo scripts against my real database; I do that myself.
• No new packages unless the stage says so.
