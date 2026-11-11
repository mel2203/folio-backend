const { AppError, BusinessRuleError } = require('../errors');

function createContactService(table, label) {
  const columns = (alias = table) => `${alias}.id, ${alias}.name, ${alias}.email, ${alias}.phone, ${alias}.address,
    ${alias}.payment_terms_days AS "paymentTermsDays", ${alias}.is_active AS "isActive",
    ${alias}.created_at AS "createdAt"`;

  async function list(client, companyId, filters) {
    const conditions = [`${table}.company_id = $1`];
    const values = [companyId];
    if (filters.active !== undefined) {
      values.push(filters.active === 'true');
      conditions.push(`${table}.is_active = $${values.length}`);
    }
    if (filters.search) {
      values.push(`%${filters.search}%`);
      conditions.push(`(${table}.name ILIKE $${values.length} OR ${table}.email ILIKE $${values.length})`);
    }
    const where = conditions.join(' AND ');
    const count = await client.query(`SELECT COUNT(*)::int AS total FROM ${table} ${table} WHERE ${where}`, values);
    const pageValues = [...values, filters.limit, (filters.page - 1) * filters.limit];
    const rows = await client.query(
      `SELECT ${columns()}
       FROM ${table} ${table}
       WHERE ${where}
       ORDER BY ${table}.name ASC, ${table}.id ASC
       LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues,
    );
    return { data: rows.rows, meta: { page: filters.page, limit: filters.limit, total: count.rows[0].total } };
  }

  async function create(client, companyId, input) {
    const result = await client.query(
      `INSERT INTO ${table} (company_id, name, email, phone, address, payment_terms_days)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${columns(table)}`,
      [companyId, input.name, input.email ?? null, input.phone ?? null, input.address ?? null, input.paymentTermsDays ?? 30],
    );
    return result.rows[0];
  }

  async function get(client, companyId, id) {
    const result = await client.query(
      `SELECT ${columns()}
       FROM ${table} ${table}
       WHERE ${table}.company_id = $1 AND ${table}.id = $2`,
      [companyId, id],
    );
    if (!result.rowCount) throw new AppError(`${label} not found`, { statusCode: 404, code: 'NOT_FOUND' });
    return result.rows[0];
  }

  async function update(client, companyId, id, changes) {
    const currentResult = await client.query(
      `SELECT ${columns()} FROM ${table} ${table}
       WHERE ${table}.company_id = $1 AND ${table}.id = $2`,
      [companyId, id],
    );
    if (!currentResult.rowCount) throw new AppError(`${label} not found`, { statusCode: 404, code: 'NOT_FOUND' });
    const old = currentResult.rows[0];
    if (changes.isActive === false && !old.isActive) {
      throw new BusinessRuleError(`${label} is already inactive`);
    }
    const result = await client.query(
      `UPDATE ${table}
       SET name = $3, email = $4, phone = $5, address = $6,
           payment_terms_days = $7, is_active = $8
       WHERE company_id = $1 AND id = $2
       RETURNING ${columns(table)}`,
      [companyId, id, changes.name ?? old.name,
        Object.hasOwn(changes, 'email') ? changes.email : old.email,
        Object.hasOwn(changes, 'phone') ? changes.phone : old.phone,
        Object.hasOwn(changes, 'address') ? changes.address : old.address,
        changes.paymentTermsDays ?? old.paymentTermsDays, changes.isActive ?? old.isActive],
    );
    return result.rows[0];
  }

  return { create, get, list, update };
}

module.exports = { createContactService };
