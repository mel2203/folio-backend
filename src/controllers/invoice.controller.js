const { pool, withTransaction } = require('../config/db');
const {
  createInvoice: createInvoiceService,
  deleteInvoice: deleteInvoiceService,
  getInvoice,
  listInvoices,
  recordPayment: recordPaymentService,
  sendInvoice: sendInvoiceService,
  updateInvoice: updateInvoiceService,
  voidInvoice: voidInvoiceService,
} = require('../services/invoice.service');

async function list(req, res) {
  const result = await listInvoices(pool, req.companyId, req.validated.query);
  res.status(200).json(result);
}

async function create(req, res) {
  const invoice = await withTransaction((client) => createInvoiceService(client, req.companyId, req.validated.body));
  res.status(201).json({ data: invoice });
}

async function get(req, res) {
  const invoice = await getInvoice(pool, req.companyId, req.validated.params.id);
  res.status(200).json({ data: invoice });
}

async function update(req, res) {
  const invoice = await withTransaction((client) => updateInvoiceService(
    client, req.companyId, req.validated.params.id, req.validated.body,
  ));
  res.status(200).json({ data: invoice });
}

async function remove(req, res) {
  await withTransaction((client) => deleteInvoiceService(client, req.companyId, req.validated.params.id));
  res.status(204).end();
}

async function send(req, res) {
  const invoice = await withTransaction((client) => sendInvoiceService(client, req.companyId, req.validated.params.id));
  res.status(200).json({ data: invoice });
}

async function voidInvoice(req, res) {
  const invoice = await withTransaction((client) => voidInvoiceService(client, req.companyId, req.validated.params.id));
  res.status(200).json({ data: invoice });
}

async function payment(req, res) {
  const result = await withTransaction((client) => recordPaymentService(
    client, req.companyId, req.validated.params.id, req.validated.body,
  ));
  res.status(201).json({ data: result });
}

module.exports = { create, get, list, payment, remove, send, update, voidInvoice };
