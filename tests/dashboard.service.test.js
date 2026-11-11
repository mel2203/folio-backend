jest.mock('../src/services/ar-aging.service', () => ({
  getArAging: jest.fn(),
}));
jest.mock('../src/services/ap-aging.service', () => ({
  getApAging: jest.fn(),
}));

const { getArAging } = require('../src/services/ar-aging.service');
const { getApAging } = require('../src/services/ap-aging.service');
const { getDashboardSummary } = require('../src/services/dashboard.service');
const { dashboardSummarySchema } = require('../src/validators/dashboard.validator');
const { getTodayInKualaLumpur } = require('../src/utils/report-date');

describe('dashboard summary service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('combines company-scoped ledger aggregates and aging totals', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          currency: 'MYR',
          cashBalance: '1025.00',
          monthlyPerformance: [
            { month: '2026-11', revenue: '100.00', expenses: '40.00' },
          ],
          overdueInvoiceCount: 1,
          overdueInvoiceAmount: '81.00',
          topCustomers: [{ customerId: 'customer-1', name: 'Northstar', invoicedAmount: '106.00' }],
          topExpenseAccounts: [{ accountId: 'expense-1', code: '6000', name: 'Rent', amount: '40.00' }],
        }],
      }),
    };
    getArAging.mockResolvedValue({ totals: { total: '81.00' } });
    getApAging.mockResolvedValue({ totals: { total: '40.00' } });

    const result = await getDashboardSummary(client, 'company-1', { asOf: '2026-11-11' });

    expect(result).toEqual({
      asOf: '2026-11-11',
      currency: 'MYR',
      balances: { cash: '1025.00', accountsReceivable: '81.00', accountsPayable: '40.00' },
      netIncomeThisMonth: '60.00',
      monthlyPerformance: [{ month: '2026-11', revenue: '100.00', expenses: '40.00' }],
      overdueInvoices: { count: 1, amount: '81.00' },
      topCustomers: [{ customerId: 'customer-1', name: 'Northstar', invoicedAmount: '106.00' }],
      topExpenseAccounts: [{ accountId: 'expense-1', code: '6000', name: 'Rent', amount: '40.00' }],
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("account.system_role = 'cash'"),
      ['company-1', '2026-11-11'],
    );
    expect(client.query.mock.calls[0][0]).toContain("entry.status = 'posted'");
    expect(getArAging).toHaveBeenCalledWith(client, 'company-1', { asOf: '2026-11-11' });
    expect(getApAging).toHaveBeenCalledWith(client, 'company-1', { asOf: '2026-11-11' });
  });

  test('returns a zero-valued summary with six empty months for an empty company', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          currency: 'MYR',
          cashBalance: '0.00',
          monthlyPerformance: Array.from(
            { length: 6 },
            (_, index) => ({ month: `2026-0${index + 6}`, revenue: '0.00', expenses: '0.00' }),
          ),
          overdueInvoiceCount: 0,
          overdueInvoiceAmount: '0.00',
          topCustomers: [],
          topExpenseAccounts: [],
        }],
      }),
    };
    getArAging.mockResolvedValue({ totals: { total: '0.00' } });
    getApAging.mockResolvedValue({ totals: { total: '0.00' } });

    const result = await getDashboardSummary(client, 'empty-company', { asOf: '2026-11-11' });

    expect(result.balances).toEqual({
      cash: '0.00',
      accountsReceivable: '0.00',
      accountsPayable: '0.00',
    });
    expect(result.netIncomeThisMonth).toBe('0.00');
    expect(result.monthlyPerformance).toHaveLength(6);
    expect(result.monthlyPerformance.every((month) => month.revenue === '0.00' && month.expenses === '0.00')).toBe(true);
    expect(result.overdueInvoices).toEqual({ count: 0, amount: '0.00' });
    expect(result.topCustomers).toEqual([]);
    expect(result.topExpenseAccounts).toEqual([]);
    expect(client.query.mock.calls[0][1][0]).toBe('empty-company');
  });

  test('defaults the as-of date to today in Kuala Lumpur and validates explicit dates', () => {
    expect(dashboardSummarySchema.parse({ body: {}, params: {}, query: {} }).query.asOf)
      .toBe(getTodayInKualaLumpur());
    expect(() => dashboardSummarySchema.parse({
      body: {},
      params: {},
      query: { asOf: '2026-02-30' },
    })).toThrow();
  });
});
