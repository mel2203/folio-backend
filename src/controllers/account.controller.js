const { pool } = require('../config/db');
const { listAccounts } = require('../services/account.service');

async function getAccounts(req, res) {
  const accounts = await listAccounts(pool, req.companyId);
  res.status(200).json({ data: accounts });
}

module.exports = { getAccounts };
