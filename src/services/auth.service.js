const { randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, withTransaction } = require('../config/db');
const { AppError } = require('../errors');
const { seedDefaultAccounts } = require('./chart-of-accounts.service');

const PASSWORD_HASH_COST = 12;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  randomBytes(32).toString('hex'),
  PASSWORD_HASH_COST,
);
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

async function register({ companyName, fullName, email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_COST);

  try {
    return await withTransaction(async (client) => {
      const companyResult = await client.query(
        `INSERT INTO companies (name)
         VALUES ($1)
         RETURNING id, name, base_currency AS "baseCurrency", created_at AS "createdAt"`,
        [companyName.trim()],
      );
      const company = companyResult.rows[0];

      const userResult = await client.query(
        `INSERT INTO users (company_id, email, password_hash, full_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, company_id AS "companyId", email,
                   full_name AS "fullName", created_at AS "createdAt"`,
        [company.id, normalizedEmail, passwordHash, fullName.trim()],
      );

      await seedDefaultAccounts(client, company.id);

      return { user: userResult.rows[0], company };
    });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'idx_users_email_lower') {
      throw new AppError('An account with this email already exists', {
        statusCode: 409,
        code: 'EMAIL_IN_USE',
      });
    }

    throw error;
  }
}

async function login({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  const userResult = await pool.query(
    `SELECT id, company_id AS "companyId", email,
            full_name AS "fullName", password_hash AS "passwordHash"
     FROM users
     WHERE LOWER(email) = $1`,
    [normalizedEmail],
  );
  const user = userResult.rows[0];
  const passwordMatches = await bcrypt.compare(
    password,
    user ? user.passwordHash : DUMMY_PASSWORD_HASH,
  );

  if (!user || !passwordMatches) {
    throw new AppError(INVALID_CREDENTIALS_MESSAGE, {
      statusCode: 401,
      code: 'UNAUTHENTICATED',
    });
  }

  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN;
  if (!secret || !expiresIn) {
    throw new Error('JWT_SECRET and JWT_EXPIRES_IN must be set before login');
  }

  const token = jwt.sign(
    { sub: user.id },
    secret,
    { algorithm: 'HS256', expiresIn },
  );
  const { passwordHash, ...safeUser } = user;

  return { token, user: safeUser };
}

async function getCurrentUser(userId) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.full_name AS "fullName",
            c.id AS "companyId", c.name AS "companyName",
            c.base_currency AS "baseCurrency"
     FROM users u
     JOIN companies c ON c.id = u.company_id
     WHERE u.id = $1`,
    [userId],
  );
  const row = result.rows[0];

  if (!row) {
    throw new AppError('Authentication required', {
      statusCode: 401,
      code: 'UNAUTHENTICATED',
    });
  }

  return {
    user: {
      id: row.id,
      email: row.email,
      fullName: row.fullName,
    },
    company: {
      id: row.companyId,
      name: row.companyName,
      baseCurrency: row.baseCurrency,
    },
  };
}

module.exports = { register, login, getCurrentUser };
