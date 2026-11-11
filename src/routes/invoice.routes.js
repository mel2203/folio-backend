const express = require('express');
const { create, get, list, payment, remove, send, update, voidInvoice } = require('../controllers/invoice.controller');
const validateRequest = require('../middleware/validate-request');
const { createInvoiceSchema, invoiceIdSchema, listInvoicesSchema, paymentSchema, updateInvoiceSchema } = require('../validators/sales.validator');

const router = express.Router();
router.get('/', validateRequest(listInvoicesSchema), list);
router.post('/', validateRequest(createInvoiceSchema), create);
router.post('/:id/send', validateRequest(invoiceIdSchema), send);
router.post('/:id/void', validateRequest(invoiceIdSchema), voidInvoice);
router.post('/:id/payments', validateRequest(paymentSchema), payment);
router.get('/:id', validateRequest(invoiceIdSchema), get);
router.patch('/:id', validateRequest(updateInvoiceSchema), update);
router.delete('/:id', validateRequest(invoiceIdSchema), remove);

module.exports = router;
