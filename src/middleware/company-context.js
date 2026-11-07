const { AppError } = require('../errors');

function companyContext(req, res, next) {
  // TEMPORARY: replaced by auth in Phase 2
  const companyId = process.env.DEV_COMPANY_ID;

  if (!companyId) {
    return next(new AppError('Company context is not configured', {
      statusCode: 503,
      code: 'COMPANY_CONTEXT_UNAVAILABLE',
    }));
  }

  req.companyId = companyId;
  return next();
}

module.exports = companyContext;
