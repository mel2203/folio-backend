const { z } = require('zod');
const { dateSchema } = require('./report.validator');
const { getTodayInKualaLumpur } = require('../utils/report-date');

const dashboardSummarySchema = z.object({
  body: z.object({}).strict(),
  params: z.object({}).strict(),
  query: z.object({ asOf: dateSchema.optional() }).strict()
    .transform(({ asOf }) => ({ asOf: asOf || getTodayInKualaLumpur() })),
});

module.exports = { dashboardSummarySchema };
