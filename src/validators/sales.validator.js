const { z } = require('zod');
const { getTodayInKualaLumpur } = require('../utils/report-date');

const dateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must use YYYY-MM-DD format')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Date must be a valid calendar date');

function decimalSchema(maxWholeDigits, { positive = false } = {}) {
  return z.string()
    .regex(new RegExp(`^\\d{1,${maxWholeDigits}}(?:\\.\\d{1,2})?$`), 'Enter a decimal with at most two decimal places')
    .refine((value) => {
      if (!positive) return true;
      const [whole, fraction = ''] = value.split('.');
      return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) > 0n;
    }, {
      message: 'Value must be greater than zero',
    });
}

const moneySchema = decimalSchema(12);
const positiveMoneySchema = decimalSchema(12, { positive: true });
const quantitySchema = decimalSchema(8, { positive: true });
const taxRateSchema = z.string()
  .regex(/^(?:\d{1,2}|100)(?:\.\d{1,2})?$/, 'Tax rate must be between 0 and 100 with at most two decimal places')
  .refine((value) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) <= 10000n;
  }, 'Tax rate must be between 0 and 100');

const uuidSchema = z.string().uuid();
const optionalText = (max) => z.string().trim().max(max).nullable().optional();
const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const emptyBody = z.object({}).strict();
const emptyParams = z.object({}).strict();
const emptyQuery = z.object({}).strict();

const customerFields = {
  name: z.string().trim().min(1).max(150),
  email: optionalText(254),
  phone: optionalText(50),
  address: optionalText(1000),
  paymentTermsDays: z.number().int().min(0).max(3650),
};

const listCustomersSchema = z.object({
  body: emptyBody,
  params: emptyParams,
  query: z.object({
    search: z.string().trim().max(150).optional(),
    active: z.enum(['true', 'false']).optional(),
    ...pagination,
  }).strict(),
});

const createCustomerSchema = z.object({
  body: z.object({
    name: customerFields.name,
    email: customerFields.email,
    phone: customerFields.phone,
    address: customerFields.address,
    paymentTermsDays: customerFields.paymentTermsDays.optional(),
  }).strict(),
  params: emptyParams,
  query: emptyQuery,
});

const updateCustomerSchema = z.object({
  body: z.object({
    name: customerFields.name.optional(),
    email: customerFields.email,
    phone: customerFields.phone,
    address: customerFields.address,
    paymentTermsDays: customerFields.paymentTermsDays.optional(),
    isActive: z.boolean().optional(),
  }).strict().refine((body) => Object.keys(body).length > 0, 'At least one customer field must be provided'),
  params: z.object({ id: uuidSchema }).strict(),
  query: emptyQuery,
});

const getCustomerSchema = z.object({ body: emptyBody, params: z.object({ id: uuidSchema }).strict(), query: emptyQuery });

const invoiceItemSchema = z.object({
  description: z.string().trim().min(1).max(250),
  quantity: quantitySchema,
  unitPrice: moneySchema,
  taxRate: taxRateSchema,
  revenueAccountId: uuidSchema,
}).strict();

const invoiceFields = {
  customerId: uuidSchema,
  issueDate: dateSchema,
  dueDate: dateSchema,
  items: z.array(invoiceItemSchema).min(1).max(100),
  notes: optionalText(5000),
};

const listInvoicesSchema = z.object({
  body: emptyBody,
  params: emptyParams,
  query: z.object({
    status: z.enum(['draft', 'sent', 'partial', 'paid', 'void']).optional(),
    customerId: uuidSchema.optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    number: z.string().trim().max(40).optional(),
    ...pagination,
  }).strict().refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: 'from must be on or before to', path: ['from'],
  }),
});

const createInvoiceSchema = z.object({
  body: z.object({
    customerId: invoiceFields.customerId,
    issueDate: invoiceFields.issueDate.optional(),
    dueDate: invoiceFields.dueDate.optional(),
    items: invoiceFields.items,
    notes: invoiceFields.notes,
  }).strict(),
  params: emptyParams,
  query: emptyQuery,
});

const updateInvoiceSchema = z.object({
  body: z.object({
    customerId: invoiceFields.customerId.optional(),
    issueDate: invoiceFields.issueDate.optional(),
    dueDate: invoiceFields.dueDate.optional(),
    items: invoiceFields.items.optional(),
    notes: invoiceFields.notes,
  }).strict().refine((body) => Object.keys(body).length > 0, 'At least one draft invoice field must be provided'),
  params: z.object({ id: uuidSchema }).strict(),
  query: emptyQuery,
});

const invoiceIdSchema = z.object({ body: emptyBody, params: z.object({ id: uuidSchema }).strict(), query: emptyQuery });

const paymentSchema = z.object({
  body: z.object({
    paymentDate: dateSchema.optional(),
    amount: positiveMoneySchema,
    method: z.string().trim().min(1).max(50),
    reference: optionalText(200),
    depositAccountId: uuidSchema,
  }).strict(),
  params: z.object({ id: uuidSchema }).strict(),
  query: emptyQuery,
});

const agingSchema = z.object({
  body: emptyBody,
  params: emptyParams,
  query: z.object({ asOf: dateSchema.optional() }).strict()
    .transform(({ asOf }) => ({ asOf: asOf || getTodayInKualaLumpur() })),
});

module.exports = {
  agingSchema,
  createCustomerSchema,
  createInvoiceSchema,
  getCustomerSchema,
  invoiceIdSchema,
  listCustomersSchema,
  listInvoicesSchema,
  paymentSchema,
  updateCustomerSchema,
  updateInvoiceSchema,
};
