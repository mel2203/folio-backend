# Account management API: explanation

## 1. Summary

This backend stage adds system-role metadata to the existing chart of accounts and adds protected create, list, and patch operations. Account type stays fixed after creation. The server determines normal balance from type, checks company ownership for every referenced account, and permits deactivation only for non-system accounts whose net posted balance is zero. The migration and API tests ran against the configured test database. The frontend is not changed or wired to these endpoints in this stage.

## 2. One request from route to response

For `POST /api/accounts`, Express reaches the route in `src/routes/account.routes.js` (lines 14–18). `validateRequest` applies the Zod schema in `src/validators/account.validator.js` (lines 24–33). The controller passes `req.companyId` and the validated body to the service in `src/controllers/account.controller.js` (lines 16–23). `src/services/account.service.js` checks any parent against the same company and type (lines 43–56), then inserts the account with a normal balance derived from its type (lines 7–13 and 58–71). The controller responds with HTTP 201 and `{ "data": account }`. The frontend page is not connected to this request yet.

## 3. Journal entries created

This stage creates no journal entries. It creates and updates chart-of-accounts records only. Existing entries and lines remain unchanged.

| Event | Debit account | Credit account | Example amount | Statements changed |
|---|---|---|---:|---|
| Account created, renamed, recoded, parent changed, deactivated, or reactivated | None | None | None | None |

## 4. New column and constraints

| Schema item | Purpose | Constraint |
|---|---|---|
| `accounts.system_role` (`TEXT NULL`) | Identifies built-in posting accounts by purpose, even if their codes are later edited | Partial unique index on `(company_id, system_role)` when the role is not null |

No table was added. Migration `migrations/005_account_system_roles.sql` adds the column idempotently, backfills the five requested roles by account code, and creates the partial unique index (lines 1–18). Default account seeding supplies the same roles for new companies in `src/services/chart-of-accounts.service.js` (lines 1–34).

## 5. Data protection rules

| Rule | Enforcement |
|---|---|
| Codes are 4–8 digits; names are 1–100 trimmed characters; types use the supported enum | `src/validators/account.validator.js` (lines 3–10, 24–30, 35–46) |
| PATCH cannot change type or accept unknown keys | Strict PATCH schema omits `type` (`src/validators/account.validator.js`, lines 35–46) |
| Duplicate company codes return 409 | Existing unique constraint translated by `handleDuplicateAccountCode` (`src/services/account.service.js`, lines 15–23) |
| Business queries use authenticated company ID and parameterized values | Controllers pass `req.companyId`; account queries filter `company_id` (`src/controllers/account.controller.js`, lines 8–32; `src/services/account.service.js`, lines 25–38, 46–51, 119–125) |
| Parent must belong to the same company and have the same type | `assertParent` (`src/services/account.service.js`, lines 43–56) |
| Parent cannot be self or a descendant | Recursive descendant check (`src/services/account.service.js`, lines 74–99) |
| Normal balance follows account type | `NORMAL_BALANCE_BY_TYPE` (`src/services/account.service.js`, lines 7–13) |
| System accounts cannot be deactivated | `updateAccount` (`src/services/account.service.js`, lines 143–145) |
| Other accounts cannot be deactivated with nonzero net posted balance | SQL sums posted lines for this account/company; `decimalToCents` compares exactly with zero (`src/services/account.service.js`, lines 101–115) |
| Inactive accounts cannot receive new entries | Existing journal service filters `is_active = true` (`src/services/journal.service.js`, lines 66–82) |
| Inactive account history stays in reports | Trial Balance aggregation joins accounts without filtering `is_active` (`src/services/report.service.js`, lines 13–21) |
| No account delete endpoint exists | Routes expose GET, POST, and PATCH only (`src/routes/account.routes.js`, lines 14–18) |

## 6. Tests and limits

`tests/accounts.integration.test.js` covers account creation and derived normal balance, duplicate code, invalid code/type, foreign and wrong-type parents, cycles, rename/recode, type-change rejection, deactivation restrictions, reactivation, active filtering, tenant isolation, inactive posting rejection, and historical Trial Balance output (lines 147–287). `tests/chart-of-accounts.service.test.js` checks that default account seeding sends all five roles (lines 5–59).

The full backend run completed with **8 suites passed and 75 tests passed** using `npm test -- --runInBand`. The integration suite applied the migration and used the test database. Automated tests do not cover concurrent edits to the same parent tree, production deployment, or the yet-to-be-built frontend form.

## 7. How to try it

With the backend running and a valid login token stored as `$TOKEN`:

```sh
curl -i -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"code":"9000","name":"Clearing","type":"asset"}' \
  http://localhost:3000/api/accounts
```

Expected: HTTP 201 and `data` containing `id`, `code`, `name`, `type`, `normalBalance`, `parentId`, `isActive`, and `systemRole`.

```sh
curl -i -H "Authorization: Bearer $TOKEN" \
  'http://localhost:3000/api/accounts?active=true'
```

Expected: HTTP 200 and an array of active account objects under `data`.

```sh
curl -i -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Updated clearing"}' \
  http://localhost:3000/api/accounts/ACCOUNT_UUID
```

Expected: HTTP 200 and the updated account under `data`. A duplicate code returns 409; invalid input returns 400; a foreign/missing account returns 404 on PATCH; forbidden parent or deactivation operations return 422.

## 8. Decisions and limitations

The API uses camelCase response keys so callers receive `normalBalance`, `parentId`, `isActive`, and `systemRole` consistently. Role assignment is based on current account codes only during migration; later application behavior can use the persistent role. Parent changes use a recursive query to reject cycles. Deactivation checks all-time posted net balance, while report date filters can still show historical balances for an inactive account. No delete behavior, type changes, imports, or frontend controls are included in this backend stage.

## 9. Examiner questions and short presentation

1. **Why derive normal balance on the server?** The account type determines its normal balance, so the client cannot submit a conflicting value.
2. **Why keep inactive accounts?** They remain part of posted history and reports, but the journal service will not accept new postings to them.
3. **How do you prevent cross-company parent links?** The parent lookup filters by both account ID and the authenticated company ID.
4. **Why check the net posted balance before deactivation?** An account with a remaining balance must stay available for ledger consistency.
5. **How are system accounts recognized?** A persistent `system_role` value is unique within each company and independent of editable account codes.

**60-second presentation:** “I added account management endpoints while preserving the existing double-entry ledger. The migration adds a nullable system role and backfills five built-in accounts for existing companies. New company seeding assigns those same roles. The API validates codes, names, and types; derives normal balance on the server; and scopes every account lookup to the authenticated company. Parent links must use the same company and type, and a recursive query prevents cycles. Accounts can be deactivated only when they are not system accounts and have zero net posted balance. The existing journal service rejects inactive accounts, while reports continue to include their history. The full backend test suite passed against the test database.”

## 10. Three self-check commands

```sh
rg -n "system_role|idx_accounts_company_system_role" migrations/005_account_system_roles.sql
rg -n "router\.(get|post|patch)|router\.delete" src/routes/account.routes.js
npm test -- --runInBand
```
