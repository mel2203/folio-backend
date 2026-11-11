const { AppError, BusinessRuleError } = require('../errors');

function customerColumns(alias = 'customer') {
  return `${alias}.id, ${alias}.name, ${alias}.email, ${alias}.phone, ${alias}.address,
    ${alias}.payment_terms_days AS "paymentTermsDays", ${alias}.is_active AS "isActive",
    ${alias}.created_at AS "createdAt"`;
}

async function listCustomers(client, companyId, filters) {
  const conditions = ['customer.company_id = $1'];
  const values = [companyId];
  if (filters.active !== undefined) {
    values.push(filters.active === 'true');
    conditions.push(`customer.is_active = $${values.length}`);
  }
  if (filters.search) {
    values.push(`%${filters.search}%`);
    conditions.push(`(customer.name ILIKE $${values.length} OR customer.email ILIKE $${values.length})`);
  }
  const where = conditions.join(' AND ');
  const count = await client.query(
    `SELECT COUNT(*)::int AS total FROM customers customer WHERE ${where}`,
    values,
  );
  const pageValues = [...values, filters.limit, (filters.page - 1) * filters.limit];
  const rows = await client.query(
    `SELECT ${customerColumns()}
     FROM customers customer
     WHERE ${where}
     ORDER BY customer.name ASC, customer.id ASC
     LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues,
  );
  return { data: rows.rows, meta: { page: filters.page, limit: filters.limit, total: count.rows[0].total } };
}

async function createCustomer(client, companyId, input) {
  const result = await client.query(
    `INSERT INTO customers (company_id, name, email, phone, address, payment_terms_days)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${customerColumns('customers')}`,
    [companyId, input.name, input.email ?? null, input.phone ?? null, input.address ?? null, input.paymentTermsDays ?? 30],
  );
  return result.rows[0];
}

async function getCustomer(client, companyId, customerId) {
  const result = await client.query(
    `SELECT ${customerColumns()}
     FROM customers customer
     WHERE customer.company_id = $1 AND customer.id = $2`,
    [companyId, customerId],
  );
  if (!result.rowCount) throw new AppError('Customer not found', { statusCode: 404, code: 'NOT_FOUND' });
  return result.rows[0];
}

async function updateCustomer(client, companyId, customerId, changes) {
  const current = await client.query(
    `SELECT ${customerColumns()} FROM customers customer
     WHERE customer.company_id = $1 AND customer.id = $2`,
    [companyId, customerId],
  );
  if (!current.rowCount) throw new AppError('Customer not found', { statusCode: 404, code: 'NOT_FOUND' });
  if (changes.isActive === false && current.rows[0].isActive === false) {
    throw new BusinessRuleError('Customer is already inactive');
  }

  const old = current.rows[0];
  const result = await client.query(
    `UPDATE customers
     SET name = $3, email = $4, phone = $5, address = $6,
         payment_terms_days = $7, is_active = $8
     WHERE company_id = $1 AND id = $2
     RETURNING ${customerColumns('customers')}`,
    [companyId, customerId, changes.name ?? old.name, Object.hasOwn(changes, 'email') ? changes.email : old.email,
      Object.hasOwn(changes, 'phone') ? changes.phone : old.phone,
      Object.hasOwn(changes, 'address') ? changes.address : old.address,
      changes.paymentTermsDays ?? old.paymentTermsDays, changes.isActive ?? old.isActive],
  );
  return result.rows[0];
}

module.exports = { createCustomer, getCustomer, listCustomers, updateCustomer };
