const express = require('express');
const { summary } = require('../controllers/dashboard.controller');
const validateRequest = require('../middleware/validate-request');
const { dashboardSummarySchema } = require('../validators/dashboard.validator');

const router = express.Router();
router.get('/summary', validateRequest(dashboardSummarySchema), summary);

module.exports = router;
