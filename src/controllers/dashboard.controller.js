const { pool } = require('../config/db');
const { getDashboardSummary } = require('../services/dashboard.service');

async function summary(req, res) {
  const data = await getDashboardSummary(pool, req.companyId, req.validated.query);
  res.status(200).json({ data });
}

module.exports = { summary };
