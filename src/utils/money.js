function validateMoneyAmount(amount) {
  if (typeof amount !== 'string') {
    throw new TypeError('Money amounts must be decimal strings');
  }

  if (!/^-?\d+(?:\.\d{1,2})?$/.test(amount)) {
    throw new RangeError('Money amounts must have at most two decimal places');
  }

  return amount;
}

function decimalToCents(amount) {
  validateMoneyAmount(amount);

  const isNegative = amount.startsWith('-');
  const unsignedAmount = isNegative ? amount.slice(1) : amount;
  const [wholePart, fractionalPart = ''] = unsignedAmount.split('.');
  const cents = (BigInt(wholePart) * 100n)
    + BigInt(fractionalPart.padEnd(2, '0') || '0');

  return isNegative ? -cents : cents;
}

function centsToDecimal(cents) {
  if (typeof cents !== 'bigint') {
    throw new TypeError('Cents must be a BigInt');
  }

  const isNegative = cents < 0n;
  const absoluteCents = isNegative ? -cents : cents;
  const wholePart = absoluteCents / 100n;
  const fractionalPart = (absoluteCents % 100n).toString().padStart(2, '0');

  return `${isNegative ? '-' : ''}${wholePart}.${fractionalPart}`;
}

function addCents(left, right) {
  if (typeof left !== 'bigint' || typeof right !== 'bigint') {
    throw new TypeError('Cents values must be BigInts');
  }

  return left + right;
}

module.exports = {
  validateMoneyAmount,
  decimalToCents,
  centsToDecimal,
  addCents,
};
