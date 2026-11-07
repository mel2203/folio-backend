class AppError extends Error {
  constructor(message, { statusCode = 500, code = 'INTERNAL_SERVER_ERROR', details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

class BusinessRuleError extends AppError {
  constructor(message) {
    super(message, { statusCode: 422, code: 'BUSINESS_RULE_VIOLATION' });
  }
}

module.exports = { AppError, BusinessRuleError };
