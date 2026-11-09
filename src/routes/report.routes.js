const express = require('express');
const { trialBalance, incomeStatement, balanceSheet } = require('../controllers/report.controller');
const validateRequest = require('../middleware/validate-request');
const { trialBalanceSchema, incomeStatementSchema, balanceSheetSchema } = require('../validators/report.validator');

const router = express.Router();
router.get('/trial-balance', validateRequest(trialBalanceSchema), trialBalance);
router.get('/income-statement', validateRequest(incomeStatementSchema), incomeStatement);
router.get('/balance-sheet', validateRequest(balanceSheetSchema), balanceSheet);

module.exports = router;
