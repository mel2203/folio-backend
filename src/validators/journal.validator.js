const { z } = require('zod');

const dateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must use YYYY-MM-DD format')
  .refine((value) => {
    const parsedDate = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsedDate.getTime())
      && parsedDate.toISOString().slice(0, 10) === value;
  }, 'Date must be a valid calendar date');

const amountSchema = z.string()
  .regex(/^-?\d+(?:\.\d{1,2})?$/, 'Amount must be a decimal string with at most two decimal places');

const journalLineSchema = z.object({
  accountId: z.string().uuid(),
  debit: amountSchema,
  credit: amountSchema,
  description: z.string().max(500).optional(),
}).strict();

const createJournalEntrySchema = z.object({
  body: z.object({
    date: dateSchema,
    memo: z.string().max(1000).nullable().optional(),
    lines: z.array(journalLineSchema).min(1),
  }).strict(),
  params: z.object({}),
  query: z.object({}),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const listJournalEntriesSchema = z.object({
  body: z.object({}),
  params: z.object({}),
  query: paginationSchema.extend({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    status: z.enum(['posted', 'void']).optional(),
  }).refine(
    (query) => !query.from || !query.to || query.from <= query.to,
    { message: 'from must be on or before to', path: ['from'] },
  ),
});

const getJournalEntrySchema = z.object({
  body: z.object({}),
  params: z.object({ id: z.string().uuid() }),
  query: z.object({}),
});

module.exports = {
  createJournalEntrySchema,
  listJournalEntriesSchema,
  getJournalEntrySchema,
};
