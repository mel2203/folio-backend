const express = require('express');
const {
  createAccount,
  getAccounts,
  updateAccount,
} = require('../controllers/account.controller');
const validateRequest = require('../middleware/validate-request');
const {
  createAccountSchema,
  listAccountsSchema,
  updateAccountSchema,
} = require('../validators/account.validator');

const router = express.Router();

router.get('/', validateRequest(listAccountsSchema), getAccounts);
router.post('/', validateRequest(createAccountSchema), createAccount);
router.patch('/:id', validateRequest(updateAccountSchema), updateAccount);

module.exports = router;
