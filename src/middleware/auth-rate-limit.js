const { rateLimit } = require('express-rate-limit');

function createAuthRateLimiter({ windowMs, limit }) {
  if (process.env.NODE_ENV === 'test') {
    return (req, res, next) => next();
  }

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler(req, res) {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many authentication attempts',
          details: [],
        },
      });
    },
  });
}

module.exports = createAuthRateLimiter;
