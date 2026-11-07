Project context
Folio is a double-entry accounting and invoicing web app for small businesses in Malaysia (default currency MYR). This repository is the backend only: a Node.js and Express REST API using PostgreSQL (hosted on Supabase). The React frontend lives in a separate repository (folio-frontend) and must not be touched or referenced from here.
Tech stack (do not change)
• Node.js with CommonJS (require / module.exports). No TypeScript.
• Express for the API, cors, dotenv.
• pg (node-postgres) with parameterised SQL. No ORM (no Prisma, Sequelize, TypeORM, Knex).
• zod for request validation.
• jest and supertest for tests.
• Plain SQL migration files in migrations/.
• Allowed additions from Phase 2: bcryptjs, jsonwebtoken, express-rate-limit, helmet. Do not add any other dependency without asking first and explaining why.

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
