const { AppError, BusinessRuleError } = require('../errors');
const { decimalToCents } = require('../utils/money');

const ACCOUNT_COLUMNS = `id, code, name, type, normal_balance AS "normalBalance",
  parent_id AS "parentId", is_active AS "isActive", system_role AS "systemRole"`;

const NORMAL_BALANCE_BY_TYPE = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

function handleDuplicateAccountCode(error) {
  if (error.code === '23505' && error.constraint === 'accounts_company_id_code_key') {
    throw new AppError('An account with this code already exists', {
      statusCode: 409,
      code: 'ACCOUNT_CODE_IN_USE',
    });
  }
  throw error;
}

async function listAccounts(client, companyId, active) {
  const values = [companyId];
  const activeFilter = active === undefined
    ? ''
    : 'AND is_active = $2';
  if (active !== undefined) values.push(active);

  const result = await client.query(
    `SELECT ${ACCOUNT_COLUMNS}
     FROM accounts
     WHERE company_id = $1 ${activeFilter}
     ORDER BY code ASC`,
    values,
  );

  return result.rows;
}

async function assertParent(client, companyId, type, parentId) {
  if (parentId === null) return;

  const result = await client.query(
    `SELECT id
     FROM accounts
     WHERE id = $1 AND company_id = $2 AND type = $3`,
    [parentId, companyId, type],
  );

  if (result.rowCount === 0) {
    throw new BusinessRuleError('Parent account must belong to the same company and have the same type');
  }
}

async function createAccount(client, companyId, { code, name, type, parentId = null }) {
  await assertParent(client, companyId, type, parentId);

  try {
    const result = await client.query(
      `INSERT INTO accounts (company_id, code, name, type, normal_balance, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${ACCOUNT_COLUMNS}`,
      [companyId, code, name, type, NORMAL_BALANCE_BY_TYPE[type], parentId],
    );
    return result.rows[0];
  } catch (error) {
    handleDuplicateAccountCode(error);
  }
}

async function assertNotDescendant(client, companyId, accountId, parentId) {
  if (parentId.toLowerCase() === accountId.toLowerCase()) {
    throw new BusinessRuleError('An account cannot be its own parent');
  }

  const result = await client.query(
    `WITH RECURSIVE descendants(id) AS (
       SELECT id
       FROM accounts
       WHERE company_id = $1 AND parent_id = $2
       UNION
       SELECT child.id
       FROM accounts child
       JOIN descendants parent ON child.parent_id = parent.id
       WHERE child.company_id = $1
     )
     SELECT EXISTS (
       SELECT 1 FROM descendants WHERE id = $3
     ) AS creates_cycle`,
    [companyId, accountId, parentId],
  );

  if (result.rows[0].creates_cycle) {
    throw new BusinessRuleError('Parent account cannot be a descendant of this account');
  }
}

async function assertZeroPostedBalance(client, companyId, accountId) {
  const result = await client.query(
    `SELECT COALESCE(SUM(journal_line.debit - journal_line.credit), 0)::text AS balance
     FROM journal_lines journal_line
     JOIN journal_entries journal_entry
       ON journal_entry.id = journal_line.entry_id
     WHERE journal_line.account_id = $1
       AND journal_entry.company_id = $2
       AND journal_entry.status = 'posted'`,
    [accountId, companyId],
  );

  if (decimalToCents(result.rows[0].balance) !== 0n) {
    throw new BusinessRuleError('Account cannot be deactivated while its net posted balance is not zero');
  }
}

async function updateAccount(client, companyId, accountId, changes) {
  const accountResult = await client.query(
    `SELECT ${ACCOUNT_COLUMNS}
     FROM accounts
     WHERE id = $1 AND company_id = $2
     FOR UPDATE`,
    [accountId, companyId],
  );
  const current = accountResult.rows[0];

  if (!current) {
    throw new AppError('Account not found', { statusCode: 404, code: 'NOT_FOUND' });
  }

  const nextParentId = Object.hasOwn(changes, 'parentId')
    ? changes.parentId
    : current.parentId;

  if (Object.hasOwn(changes, 'parentId')) {
    await assertParent(client, companyId, current.type, nextParentId);
    if (nextParentId !== null) {
      await assertNotDescendant(client, companyId, current.id, nextParentId);
    }
  }

  if (changes.isActive === false && current.systemRole) {
    throw new BusinessRuleError('System accounts cannot be deactivated');
  }

  if (changes.isActive === false && current.isActive) {
    await assertZeroPostedBalance(client, companyId, current.id);
  }

  try {
    const result = await client.query(
      `UPDATE accounts
       SET name = $3, code = $4, parent_id = $5, is_active = $6
       WHERE id = $1 AND company_id = $2
       RETURNING ${ACCOUNT_COLUMNS}`,
      [
        accountId,
        companyId,
        changes.name ?? current.name,
        changes.code ?? current.code,
        nextParentId,
        changes.isActive ?? current.isActive,
      ],
    );
    return result.rows[0];
  } catch (error) {
    handleDuplicateAccountCode(error);
  }
}

module.exports = { createAccount, listAccounts, updateAccount };
