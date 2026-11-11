const { BusinessRuleError } = require('../errors');

function assertDocumentStatus(status, allowedStatuses, message) {
  if (!allowedStatuses.includes(status)) throw new BusinessRuleError(message);
}

function nextPaymentStatus(totalCents, paidCents) {
  return paidCents === totalCents ? 'paid' : 'partial';
}

module.exports = { assertDocumentStatus, nextPaymentStatus };
