const { pool, withTransaction } = require('../config/db');
const {
  createAccount: createAccountService,
  listAccounts,
  updateAccount: updateAccountService,
} = require('../services/account.service');

async function getAccounts(req, res) {
  const active = req.validated.query.active === undefined
    ? undefined
    : req.validated.query.active === 'true';
  const accounts = await listAccounts(pool, req.companyId, active);
  res.status(200).json({ data: accounts });
}

async function createAccount(req, res) {
  const account = await createAccountService(
    pool,
    req.companyId,
    req.validated.body,
  );
  res.status(201).json({ data: account });
}

async function updateAccount(req, res) {
  const account = await withTransaction((client) => updateAccountService(
    client,
    req.companyId,
    req.validated.params.id,
    req.validated.body,
  ));
  res.status(200).json({ data: account });
}

module.exports = { createAccount, getAccounts, updateAccount };
