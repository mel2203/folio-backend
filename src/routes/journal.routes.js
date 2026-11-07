const express = require('express');
const {
  createJournalEntry,
  getEntry,
  listEntries,
} = require('../controllers/journal.controller');
const validateRequest = require('../middleware/validate-request');
const {
  createJournalEntrySchema,
  getJournalEntrySchema,
  listJournalEntriesSchema,
} = require('../validators/journal.validator');

const router = express.Router();

router.post(
  '/',
  validateRequest(createJournalEntrySchema),
  createJournalEntry,
);
router.get(
  '/',
  validateRequest(listJournalEntriesSchema),
  listEntries,
);
router.get(
  '/:id',
  validateRequest(getJournalEntrySchema),
  getEntry,
);

module.exports = router;
