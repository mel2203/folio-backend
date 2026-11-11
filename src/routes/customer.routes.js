const express = require('express');
const { create, get, list, update } = require('../controllers/customer.controller');
const validateRequest = require('../middleware/validate-request');
const { createCustomerSchema, getCustomerSchema, listCustomersSchema, updateCustomerSchema } = require('../validators/sales.validator');

const router = express.Router();
router.get('/', validateRequest(listCustomersSchema), list);
router.post('/', validateRequest(createCustomerSchema), create);
router.get('/:id', validateRequest(getCustomerSchema), get);
router.patch('/:id', validateRequest(updateCustomerSchema), update);

module.exports = router;
