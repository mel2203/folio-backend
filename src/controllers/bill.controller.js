const { pool, withTransaction } = require('../config/db');
const {
  createBill: createBillService,
  deleteBill: deleteBillService,
  getBill,
  listBills,
  postBill: postBillService,
  recordBillPayment,
  updateBill: updateBillService,
  voidBill: voidBillService,
} = require('../services/bill.service');

async function list(req, res) {
  res.status(200).json(await listBills(pool, req.companyId, req.validated.query));
}

async function create(req, res) {
  const bill = await withTransaction((client) => createBillService(client, req.companyId, req.validated.body));
  res.status(201).json({ data: bill });
}

async function get(req, res) {
  res.status(200).json({ data: await getBill(pool, req.companyId, req.validated.params.id) });
}

async function update(req, res) {
  const bill = await withTransaction((client) => updateBillService(
    client, req.companyId, req.validated.params.id, req.validated.body,
  ));
  res.status(200).json({ data: bill });
}

async function remove(req, res) {
  await withTransaction((client) => deleteBillService(client, req.companyId, req.validated.params.id));
  res.status(204).end();
}

async function post(req, res) {
  const bill = await withTransaction((client) => postBillService(client, req.companyId, req.validated.params.id));
  res.status(200).json({ data: bill });
}

async function payment(req, res) {
  const result = await withTransaction((client) => recordBillPayment(
    client, req.companyId, req.validated.params.id, req.validated.body,
  ));
  res.status(201).json({ data: result });
}

async function voidBill(req, res) {
  const bill = await withTransaction((client) => voidBillService(client, req.companyId, req.validated.params.id));
  res.status(200).json({ data: bill });
}

module.exports = { create, get, list, payment, post, remove, update, voidBill };
