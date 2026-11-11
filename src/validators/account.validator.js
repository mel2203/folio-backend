const { z } = require('zod');

const accountCodeSchema = z.string()
  .regex(/^\d{4,8}$/, 'Code must contain 4 to 8 digits');
const accountNameSchema = z.string()
  .trim()
  .min(1, 'Name is required')
  .max(100, 'Name must be at most 100 characters');
const accountTypeSchema = z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']);
const parentIdSchema = z.string().uuid();

const emptyBody = z.object({}).strict();
const emptyParams = z.object({}).strict();
const emptyQuery = z.object({}).strict();

const listAccountsSchema = z.object({
  body: emptyBody,
  params: emptyParams,
  query: z.object({
    active: z.enum(['true', 'false']).optional(),
  }).strict(),
});

const createAccountSchema = z.object({
  body: z.object({
    code: accountCodeSchema,
    name: accountNameSchema,
    type: accountTypeSchema,
    parentId: parentIdSchema.optional(),
  }).strict(),
  params: emptyParams,
  query: emptyQuery,
});

const updateAccountSchema = z.object({
  body: z.object({
    name: accountNameSchema.optional(),
    code: accountCodeSchema.optional(),
    parentId: parentIdSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  }).strict().refine((body) => Object.keys(body).length > 0, {
    message: 'At least one account field must be provided',
  }),
  params: z.object({ id: z.string().uuid() }).strict(),
  query: emptyQuery,
});

module.exports = { createAccountSchema, listAccountsSchema, updateAccountSchema };
