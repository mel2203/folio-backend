async function listAccounts(client, companyId) {
  const result = await client.query(
    `SELECT id, code, name, type, normal_balance, is_active
     FROM accounts
     WHERE company_id = $1
     ORDER BY code ASC`,
    [companyId],
  );

  return result.rows;
}

module.exports = { listAccounts };
