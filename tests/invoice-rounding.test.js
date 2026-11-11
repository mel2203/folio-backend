const { calculateInvoiceItems } = require('../src/services/invoice.service');

describe('invoice line rounding', () => {
  test('rounds line net and tax half up before totaling the invoice', () => {
    const result = calculateInvoiceItems([
      { description: 'Tax example', quantity: '1.00', unitPrice: '0.25', taxRate: '6.00', revenueAccountId: 'rev' },
      { description: 'Half cent net', quantity: '0.10', unitPrice: '0.25', taxRate: '0.00', revenueAccountId: 'rev' },
    ]);

    expect(result.items.map(({ lineSubtotal, lineTax, lineTotal }) => ({ lineSubtotal, lineTax, lineTotal })))
      .toEqual([
        { lineSubtotal: '0.25', lineTax: '0.02', lineTotal: '0.27' },
        { lineSubtotal: '0.03', lineTax: '0.00', lineTotal: '0.03' },
      ]);
    expect(result.subtotalCents).toBe(28n);
    expect(result.taxTotalCents).toBe(2n);
    expect(result.totalCents).toBe(30n);
  });
});
