const { pool } = require('../config/db');
const { createCustomer: createCustomerService, getCustomer, listCustomers, updateCustomer: updateCustomerService } = require('../services/customer.service');

async function list(req, res) {
  const result = await listCustomers(pool, req.companyId, req.validated.query);
  res.status(200).json(result);
}

async function create(req, res) {
  const customer = await createCustomerService(pool, req.companyId, req.validated.body);
  res.status(201).json({ data: customer });
}

async function get(req, res) {
  const customer = await getCustomer(pool, req.companyId, req.validated.params.id);
  res.status(200).json({ data: customer });
}

async function update(req, res) {
  const customer = await updateCustomerService(pool, req.companyId, req.validated.params.id, req.validated.body);
  res.status(200).json({ data: customer });
}

module.exports = { create, get, list, update };
