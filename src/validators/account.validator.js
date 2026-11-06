const { z } = require('zod');

const listAccountsSchema = z.object({
  body: z.object({}),
  params: z.object({}),
  query: z.object({}),
});

module.exports = { listAccountsSchema };
