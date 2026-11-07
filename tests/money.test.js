const {
  validateMoneyAmount,
  decimalToCents,
  centsToDecimal,
  addCents,
} = require('../src/utils/money');

describe('money helpers', () => {
  test('converts decimal strings to cents without floating point arithmetic', () => {
    expect(decimalToCents('0.1')).toBe(10n);
    expect(decimalToCents('0.2')).toBe(20n);
    expect(addCents(decimalToCents('0.1'), decimalToCents('0.2'))).toBe(30n);
  });

  test('converts cents to a two-decimal string', () => {
    expect(centsToDecimal(500000n)).toBe('5000.00');
    expect(centsToDecimal(-1n)).toBe('-0.01');
  });

  test('preserves values beyond JavaScript safe integer precision', () => {
    expect(decimalToCents('9007199254740993.01')).toBe(900719925474099301n);
  });

  test('accepts no more than two decimal places', () => {
    expect(validateMoneyAmount('12')).toBe('12');
    expect(validateMoneyAmount('12.3')).toBe('12.3');
    expect(validateMoneyAmount('12.34')).toBe('12.34');
    expect(() => validateMoneyAmount('12.345')).toThrow(RangeError);
    expect(() => decimalToCents('12.345')).toThrow(RangeError);
  });

  test('rejects malformed or non-string amounts', () => {
    expect(() => decimalToCents('1e2')).toThrow(RangeError);
    expect(() => decimalToCents('')).toThrow(RangeError);
    expect(() => decimalToCents(null)).toThrow(TypeError);
  });

  test('requires BigInt values for cents operations', () => {
    expect(() => centsToDecimal(100)).toThrow(TypeError);
    expect(() => addCents(10n, 20)).toThrow(TypeError);
  });
});
