const { pool, withTransaction } = require('../config/db');
const { postJournalEntry } = require('../services/journal.service');
const {
  getJournalEntry,
  listJournalEntries,
} = require('../services/journal-read.service');

async function createJournalEntry(req, res) {
  const { date, memo, lines } = req.validated.body;
  const entry = await withTransaction((client) => postJournalEntry(client, {
    companyId: req.companyId,
    date,
    memo,
    sourceType: 'manual',
    lines,
  }));

  res.status(201).json({ data: entry });
}

async function listEntries(req, res) {
  const result = await listJournalEntries(
    pool,
    req.companyId,
    req.validated.query,
  );

  res.status(200).json(result);
}

async function getEntry(req, res) {
  const entry = await getJournalEntry(
    pool,
    req.companyId,
    req.validated.params.id,
  );

  res.status(200).json({ data: entry });
}

module.exports = { createJournalEntry, listEntries, getEntry };
