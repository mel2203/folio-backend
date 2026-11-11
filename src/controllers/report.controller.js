const { pool } = require('../config/db');
const { getTrialBalance, getIncomeStatement, getBalanceSheet } = require('../services/report.service');
const { getArAging } = require('../services/ar-aging.service');
const { getApAging } = require('../services/ap-aging.service');

async function trialBalance(req, res) {
  const data = await getTrialBalance(pool, req.companyId, req.validated.query);
  res.status(200).json({ data });
}

async function incomeStatement(req, res) {
  const data = await getIncomeStatement(pool, req.companyId, req.validated.query);
  res.status(200).json({ data });
}

async function balanceSheet(req, res) {
  const data = await getBalanceSheet(pool, req.companyId, req.validated.query);
  res.status(200).json({ data });
}

async function arAgingReport(req, res) {
  const data = await getArAging(pool, req.companyId, req.validated.query);
  res.status(200).json({ data });
}

async function apAgingReport(req, res) {
  const data = await getApAging(pool, req.companyId, req.validated.query);
  res.status(200).json({ data });
}

module.exports = { trialBalance, incomeStatement, balanceSheet, arAgingReport, apAgingReport };
