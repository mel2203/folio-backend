const { z } = require('zod');
const { getTodayInKualaLumpur } = require('../utils/report-date');
const { dateSchema, decimalSchema, pagination } = require('./sales.validator');

const uuidSchema = z.string().uuid();
const optionalText = (max) => z.string().trim().max(max).nullable().optional();
const emptyBody = z.object({}).strict();
const emptyParams = z.object({}).strict();
const emptyQuery = z.object({}).strict();

const vendorFields = {
  name: z.string().trim().min(1).max(150),
  email: optionalText(254),
  phone: optionalText(50),
  address: optionalText(1000),
  paymentTermsDays: z.number().int().min(0).max(3650),
};

const listVendorsSchema = z.object({
  body: emptyBody,
  params: emptyParams,
  query: z.object({
    search: z.string().trim().max(150).optional(),
    active: z.enum(['true', 'false']).optional(),
    ...pagination,
  }).strict(),
});

const createVendorSchema = z.object({
  body: z.object({
    name: vendorFields.name,
    email: vendorFields.email,
    phone: vendorFields.phone,
    address: vendorFields.address,
    paymentTermsDays: vendorFields.paymentTermsDays.optional(),
  }).strict(),
  params: emptyParams,
  query: emptyQuery,
});

const updateVendorSchema = z.object({
  body: z.object({
    name: vendorFields.name.optional(),
    email: vendorFields.email,
    phone: vendorFields.phone,
    address: vendorFields.address,
    paymentTermsDays: vendorFields.paymentTermsDays.optional(),
    isActive: z.boolean().optional(),
  }).strict().refine((body) => Object.keys(body).length > 0, 'At least one vendor field must be provided'),
  params: z.object({ id: uuidSchema }).strict(),
  query: emptyQuery,
});

const vendorIdSchema = z.object({ body: emptyBody, params: z.object({ id: uuidSchema }).strict(), query: emptyQuery });
const billItemSchema = z.object({
  description: z.string().trim().min(1).max(250),
  amount: decimalSchema(12, { positive: true }),
  accountId: uuidSchema,
}).strict();

const billFields = {
  vendorId: uuidSchema,
  billNumber: z.string().trim().min(1).max(100),
  issueDate: dateSchema,
  dueDate: dateSchema,
  items: z.array(billItemSchema).min(1).max(100),
  notes: optionalText(5000),
};

const listBillsSchema = z.object({
  body: emptyBody,
  params: emptyParams,
  query: z.object({
    status: z.enum(['draft', 'open', 'partial', 'paid', 'void']).optional(),
    vendorId: uuidSchema.optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    number: z.string().trim().max(100).optional(),
    ...pagination,
  }).strict().refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: 'from must be on or before to', path: ['from'],
  }),
});

const createBillSchema = z.object({
  body: z.object({
    vendorId: billFields.vendorId,
    billNumber: billFields.billNumber,
    issueDate: billFields.issueDate.optional(),
    dueDate: billFields.dueDate.optional(),
    items: billFields.items,
    notes: billFields.notes,
  }).strict(),
  params: emptyParams,
  query: emptyQuery,
});

const updateBillSchema = z.object({
  body: z.object({
    vendorId: billFields.vendorId.optional(),
    billNumber: billFields.billNumber.optional(),
    issueDate: billFields.issueDate.optional(),
    dueDate: billFields.dueDate.optional(),
    items: billFields.items.optional(),
    notes: billFields.notes,
  }).strict().refine((body) => Object.keys(body).length > 0, 'At least one draft bill field must be provided'),
  params: z.object({ id: uuidSchema }).strict(),
  query: emptyQuery,
});

const billIdSchema = z.object({ body: emptyBody, params: z.object({ id: uuidSchema }).strict(), query: emptyQuery });
const billPaymentSchema = z.object({
  body: z.object({
    paymentDate: dateSchema.optional(),
    amount: decimalSchema(12, { positive: true }),
    method: z.string().trim().min(1).max(50),
    reference: optionalText(200),
    payingAccountId: uuidSchema,
  }).strict(),
  params: z.object({ id: uuidSchema }).strict(),
  query: emptyQuery,
});

const apAgingSchema = z.object({
  body: emptyBody,
  params: emptyParams,
  query: z.object({ asOf: dateSchema.optional() }).strict()
    .transform(({ asOf }) => ({ asOf: asOf || getTodayInKualaLumpur() })),
});

module.exports = {
  apAgingSchema,
  billIdSchema,
  billPaymentSchema,
  createBillSchema,
  createVendorSchema,
  getVendorSchema: vendorIdSchema,
  listBillsSchema,
  listVendorsSchema,
  updateBillSchema,
  updateVendorSchema,
};
