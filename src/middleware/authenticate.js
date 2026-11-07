const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { AppError } = require('../errors');

function unauthenticatedError() {
  return new AppError('Authentication required', {
    statusCode: 401,
    code: 'UNAUTHENTICATED',
  });
}

async function authenticate(req, res, next) {
  const authorization = req.get('authorization');
  const match = authorization && authorization.match(/^Bearer ([^\s]+)$/i);

  if (!match || !process.env.JWT_SECRET) {
    return next(unauthenticatedError());
  }

  let payload;
  try {
    payload = jwt.verify(match[1], process.env.JWT_SECRET, {
      algorithms: ['HS256'],
    });
  } catch {
    return next(unauthenticatedError());
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return next(unauthenticatedError());
  }

  try {
    const result = await pool.query(
      `SELECT id, company_id, email, full_name
       FROM users
       WHERE id = $1`,
      [payload.sub],
    );
    const user = result.rows[0];

    if (!user) {
      return next(unauthenticatedError());
    }

    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
    };
    req.companyId = user.company_id;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = authenticate;
