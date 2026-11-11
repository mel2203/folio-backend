const express = require('express');
const { create, get, list, update } = require('../controllers/vendor.controller');
const validateRequest = require('../middleware/validate-request');
const { createVendorSchema, getVendorSchema, listVendorsSchema, updateVendorSchema } = require('../validators/purchases.validator');

const router = express.Router();
router.get('/', validateRequest(listVendorsSchema), list);
router.post('/', validateRequest(createVendorSchema), create);
router.get('/:id', validateRequest(getVendorSchema), get);
router.patch('/:id', validateRequest(updateVendorSchema), update);

module.exports = router;
