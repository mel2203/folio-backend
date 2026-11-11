const express = require('express');
const { trialBalance, incomeStatement, balanceSheet, arAgingReport, apAgingReport } = require('../controllers/report.controller');
const validateRequest = require('../middleware/validate-request');
const { trialBalanceSchema, incomeStatementSchema, balanceSheetSchema } = require('../validators/report.validator');
const { agingSchema } = require('../validators/sales.validator');
const { apAgingSchema } = require('../validators/purchases.validator');

const router = express.Router();
router.get('/trial-balance', validateRequest(trialBalanceSchema), trialBalance);
router.get('/income-statement', validateRequest(incomeStatementSchema), incomeStatement);
router.get('/balance-sheet', validateRequest(balanceSheetSchema), balanceSheet);
router.get('/ar-aging', validateRequest(agingSchema), arAgingReport);
router.get('/ap-aging', validateRequest(apAgingSchema), apAgingReport);

module.exports = router;
