const express = require('express');
const { create, get, list, payment, post, remove, update, voidBill } = require('../controllers/bill.controller');
const validateRequest = require('../middleware/validate-request');
const {
  billIdSchema,
  billPaymentSchema,
  createBillSchema,
  listBillsSchema,
  updateBillSchema,
} = require('../validators/purchases.validator');

const router = express.Router();
router.get('/', validateRequest(listBillsSchema), list);
router.post('/', validateRequest(createBillSchema), create);
router.post('/:id/post', validateRequest(billIdSchema), post);
router.post('/:id/void', validateRequest(billIdSchema), voidBill);
router.post('/:id/payments', validateRequest(billPaymentSchema), payment);
router.get('/:id', validateRequest(billIdSchema), get);
router.patch('/:id', validateRequest(updateBillSchema), update);
router.delete('/:id', validateRequest(billIdSchema), remove);

module.exports = router;
