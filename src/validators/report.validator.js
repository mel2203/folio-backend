const { z } = require('zod');
const { getFirstDayOfMonth, getTodayInKualaLumpur } = require('../utils/report-date');

const dateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must use YYYY-MM-DD format')
  .refine((value) => {
    const parsedDate = new Date(value + 'T00:00:00.000Z');
    return !Number.isNaN(parsedDate.getTime())
      && parsedDate.toISOString().slice(0, 10) === value;
  }, 'Date must be a valid calendar date');

const emptyEnvelope = {
  body: z.object({}),
  params: z.object({}),
};

const trialBalanceSchema = z.object({
  ...emptyEnvelope,
  query: z.object({ asOf: dateSchema.optional() })
    .transform(({ asOf }) => ({ asOf: asOf || getTodayInKualaLumpur() })),
});

const incomeStatementSchema = z.object({
  ...emptyEnvelope,
  query: z.object({ from: dateSchema.optional(), to: dateSchema.optional() })
    .transform(({ from, to }) => {
      const today = getTodayInKualaLumpur();
      return {
        from: from || getFirstDayOfMonth(today),
        to: to || today,
      };
    })
    .refine((query) => query.from <= query.to, {
      message: 'from must be on or before to',
      path: ['from'],
    }),
});

const balanceSheetSchema = trialBalanceSchema;

module.exports = { trialBalanceSchema, incomeStatementSchema, balanceSheetSchema };
