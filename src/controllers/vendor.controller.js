const { pool } = require('../config/db');
const { createVendor, getVendor, listVendors, updateVendor } = require('../services/vendor.service');

async function list(req, res) {
  res.status(200).json(await listVendors(pool, req.companyId, req.validated.query));
}

async function create(req, res) {
  res.status(201).json({ data: await createVendor(pool, req.companyId, req.validated.body) });
}

async function get(req, res) {
  res.status(200).json({ data: await getVendor(pool, req.companyId, req.validated.params.id) });
}

async function update(req, res) {
  res.status(200).json({ data: await updateVendor(pool, req.companyId, req.validated.params.id, req.validated.body) });
}

module.exports = { create, get, list, update };
