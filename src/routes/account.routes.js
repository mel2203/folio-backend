const express = require('express');
const { getAccounts } = require('../controllers/account.controller');
const validateRequest = require('../middleware/validate-request');
const { listAccountsSchema } = require('../validators/account.validator');

const router = express.Router();

router.get('/', validateRequest(listAccountsSchema), getAccounts);

module.exports = router;
