# Purchases backend — explained

## 1. Summary

This backend stage adds vendor records, bill drafts, bill posting and payment, unpaid-bill reversals, and Accounts Payable aging. A bill is a source document. Posting it creates a balanced journal entry; the ledger remains the accounting record. Money is handled as integer cents in application code and as two-decimal strings in API responses. The frontend is intentionally not changed in this backend checkpoint.

## 2. One request end to end

When a user posts a bill, the authenticated route is mounted under `/api` in [app.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/app.js:30) and the bill route is in [bill.routes.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/routes/bill.routes.js:12). The route validates the id with Zod, a request-shape validator, in [purchases.validator.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/validators/purchases.validator.js:111). [bill.controller.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/controllers/bill.controller.js:38) opens a database transaction and passes the authenticated company id to the service. In [bill.service.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/services/bill.service.js:218), the service locks the bill row, checks that it is a draft and that the vendor and item accounts are active and belong to the company, sums amounts in cents, finds the Accounts Payable account by its system role, and calls the existing `postJournalEntry` service. The SQL inserts a journal entry and lines, then updates the bill to `open` in the same transaction. The response is `{ "data": <bill detail> }`. Bill detail joins the vendor, items, accounts, and payments in [bill.service.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/services/bill.service.js:132).

Vendors use the same generalized contact service as customers: [contact.service.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/services/contact.service.js:3) receives only the fixed internal table and label values. Customer behavior is still covered by the unchanged Sales integration tests. A/P aging follows the existing A/R aging route pattern: [report.routes.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/routes/report.routes.js:8) validates the query, and [ap-aging.service.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/services/ap-aging.service.js:3) runs one aggregate SQL query for the authenticated company.

## 3. Journal entries created by this stage

| Event | Debit | Credit | Example | Statements affected |
|---|---|---|---:|---|
| Post a bill with rent $200 and equipment $100 | Rent Expense $200; Equipment (asset) $100 | Accounts Payable $300 | $300 bill | Trial Balance; Profit and Loss through rent; Balance Sheet through equipment and A/P |
| Pay $100 of that bill | Accounts Payable $100 | Cash or other paying asset $100 | $100 partial payment | Trial Balance and Balance Sheet; no new expense |
| Void an unpaid open bill | The original credit lines | The original debit lines | Reverse the original $300 posting | The original and reversal net to zero in the Trial Balance, Profit and Loss, and Balance Sheet |

The post action is in `bill.service.js` lines 218–251. Payment is in lines 253–292. Reversal is in lines 294–316. Journal entries and lines are not edited or deleted; voiding adds a reversal entry.

## 4. New tables and columns

Migration [007_purchases.sql](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/migrations/007_purchases.sql:1) adds four tables. `vendors` stores company-scoped supplier contact details, payment terms, active state, and creation time. `bills` stores the vendor bill number, dates, lifecycle status, total, amount paid, notes, and links to posting/reversal entries. The `(company_id, vendor_id, bill_number)` tuple is unique. `bill_items` stores each positive amount, description, and selected account. `bill_payments` stores the payment date, positive amount, method, reference, paying asset account, and posted journal-entry id. The tables have checks and indexes for company, vendor, status/due date, bill, account, and payment date. Row-level security is enabled on all four tables in the migration.

## 5. Rules that protect the data

| Rule | Enforcement |
|---|---|
| Valid dates, ids, statuses, required bill number, positive decimal amounts, and pagination | [purchases.validator.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/validators/purchases.validator.js:11) reuses the Sales date, decimal, and pagination validators. `from` cannot be after `to` (lines 70–83). |
| No floating-point arithmetic for totals or payments | Bill amounts convert through `decimalToCents`, add with BigInt, and return with `centsToDecimal` in [bill.service.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/services/bill.service.js:16). The Sales line-rounding helper is now shared from [rounding.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/utils/rounding.js:1). |
| Same-company active vendor and eligible accounts | [bill.service.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/services/bill.service.js:26) checks vendor ownership/activity; lines 34–45 require active expense or asset accounts; payment lines 264–275 require an active asset paying account and the company's active A/P role. |
| Draft-only editing and deletion; post, payment, and void status transitions | [document-status.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/utils/document-status.js:3) is shared with invoices. Bill status checks are in `bill.service.js` lines 176–216 and 218–299. |
| No overpayment; partial/full status changes use the shared status helper | `bill.service.js` lines 253–292 compare integer cents; [document-status.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/utils/document-status.js:7) returns `partial` or `paid`. |
| Company isolation and parameterized SQL | Controllers pass `req.companyId`; list/detail/update and report queries filter by that id. Referenced vendors and accounts are checked before posting. |
| Aging buckets and reconciliation arithmetic match A/R behavior | [aging.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/src/utils/aging.js:5) shares SQL bucket expressions and BigInt totals between A/R and A/P; the A/P service calculates the ledger as credits minus debits. |

## 6. Tests and verification

[purchases.integration.test.js](/Users/lyanafareeha/Desktop/CODING/Bootcamp/Folio/Folio%20-%20Backend/tests/purchases.integration.test.js:133) tests vendor list/search/edit/deactivation and isolation; authentication and invalid input; payment-term due-date defaults and duplicate bill numbers; exact posting lines and Trial Balance/P&L/Balance Sheet effects; partial/full payment, overpayment and invalid paying account; draft edit/delete restrictions; wrong, inactive, and cross-company accounts/vendors; void/reversal and A/P returning to zero; tenant-isolated bills; as-of payment cutoffs; aging boundary buckets and reconciliation; malformed dates; and empty aging.

Ran the focused Purchases suite against the guarded test database: **Test Suites: 1 passed, 1 total; Tests: 10 passed, 10 total**. Ran the full backend suite before the last test-only additions: **Test Suites: 11 passed, 11 total; Tests: 98 passed, 98 total**. The focused run after those additions passed all 10 Purchases tests. Production and development databases were not used. Live HTTP deployment behavior is **not verified** in this stage.

## 7. How to try it

1. Against a local development database, run the backend setup/migration instructions in the README, then start the API with `npm run dev`. Do not use the test command against that database.
2. Sign in and keep the bearer token in a local shell variable; do not print or share it. Create a vendor with `POST /api/vendors` and JSON such as `{ "name": "Example Supplier", "paymentTermsDays": 30 }`.
3. Create a draft with `POST /api/bills`, passing the returned vendor id, a bill number, an issue date, and at least one item such as `{ "description": "Office rent", "amount": "300.00", "accountId": "<active-expense-account-id>" }`. The response should have `status: "draft"` and `total: "300.00"`.
4. Call `POST /api/bills/:id/post`. The response should have `status: "open"` and a journal entry id. Trial Balance should show an A/P credit and the selected account debit.
5. Call `POST /api/bills/:id/payments` with a positive amount and active asset account. A partial payment returns `status: "partial"`; a payment of the remaining amount returns `status: "paid"`.
6. For an unpaid open bill, call `POST /api/bills/:id/void`. It should return `status: "void"` and a reversal entry id. Then call `GET /api/reports/ap-aging?asOf=YYYY-MM-DD` to inspect vendor buckets and the A/P reconciliation result.

## 8. Decisions and limitations

Vendor contact operations share one service with customer contact operations. Invoice and bill lifecycle checks share a status helper. A/R and A/P aging share bucket SQL and cents-summary logic. The existing Sales full-suite run remained green after these code refactors. Bill numbers are supplier-provided and required at draft creation; they are not automatically sequenced. A bill item is one positive amount and has no quantity, unit price, or tax. Supplier credit notes, purchase orders, input tax, and attachments were not built. The client is pending the backend response-shape review.

## 9. Examiner questions and a short presentation

1. **Why does a bill create an expense only when posted?** A draft is not in the ledger. Posting creates the journal entry and changes the bill status in one transaction.
2. **Why can a bill item use an asset account?** Some purchased items are assets; the validator/service permits active expense or asset accounts only.
3. **What happens when a bill is paid?** The server debits A/P and credits the selected asset account. It does not record the expense again.
4. **How does voiding preserve the ledger audit trail?** The service creates a reversal entry with debit and credit sides swapped. It does not delete or change the original posted lines.
5. **What does an A/P aging difference show?** It is the credit-normal A/P ledger balance minus outstanding bill aging. A manual A/P journal entry can make the figures differ.

**60-second presentation:** “Purchases adds vendors, bill drafts, posting, payments, and A/P aging. A draft bill stores its supplier reference and item amounts, but it has no ledger effect yet. Posting debits the accounts selected on the bill lines and credits Accounts Payable. Paying a bill debits Accounts Payable and credits a cash or other asset account. The backend stores the payment and updates the bill status in the same transaction as the journal entry. An unpaid posted bill can be voided by adding a reversal, preserving the original journal. Aging groups unpaid amounts by due date and compares them with the Accounts Payable ledger. Shared money, status, and aging helpers keep these rules consistent with Sales.”

## 10. Check the implementation yourself

From the backend repository:

```sh
NODE_ENV=test npx jest tests/purchases.integration.test.js --runInBand
rg -n "postBill|recordBillPayment|voidBill|getApAging|agingBucketSql|nextPaymentStatus" src/services src/utils
rg -n "CREATE TABLE|ENABLE ROW LEVEL SECURITY|UNIQUE|CHECK" migrations/007_purchases.sql
```
