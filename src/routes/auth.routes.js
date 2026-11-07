const express = require('express');
const {
  getMe,
  loginUser,
  registerUser,
} = require('../controllers/auth.controller');
const authenticate = require('../middleware/authenticate');
const createAuthRateLimiter = require('../middleware/auth-rate-limit');
const validateRequest = require('../middleware/validate-request');
const {
  getCurrentUserSchema,
  loginSchema,
  registerSchema,
} = require('../validators/auth.validator');

const router = express.Router();
const loginRateLimit = createAuthRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
});
const registerRateLimit = createAuthRateLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
});

router.post(
  '/register',
  registerRateLimit,
  validateRequest(registerSchema),
  registerUser,
);
router.post(
  '/login',
  loginRateLimit,
  validateRequest(loginSchema),
  loginUser,
);
router.get(
  '/me',
  authenticate,
  validateRequest(getCurrentUserSchema),
  getMe,
);

module.exports = router;
