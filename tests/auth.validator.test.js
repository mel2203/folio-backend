const {
  getCurrentUserSchema,
  loginSchema,
  registerSchema,
} = require('../src/validators/auth.validator');

const emptyRequest = { params: {}, query: {} };

describe('auth request validators', () => {
  test('trims registration strings and accepts valid account fields', () => {
    const result = registerSchema.parse({
      ...emptyRequest,
      body: {
        companyName: '  Folio Ltd  ',
        fullName: '  Example User ',
        email: ' User@Example.com ',
        password: ' valid-pass-1 ',
      },
    });

    expect(result.body).toEqual({
      companyName: 'Folio Ltd',
      fullName: 'Example User',
      email: 'User@Example.com',
      password: 'valid-pass-1',
    });
  });

  test.each([
    ['malformed email', { companyName: 'Folio', fullName: 'User', email: 'not-an-email', password: 'password1' }],
    ['too-long email', { companyName: 'Folio', fullName: 'User', email: `${'a'.repeat(249)}@b.com`, password: 'password1' }],
    ['short password', { companyName: 'Folio', fullName: 'User', email: 'user@example.com', password: 'short' }],
    ['long password', { companyName: 'Folio', fullName: 'User', email: 'user@example.com', password: 'p'.repeat(73) }],
    ['empty company name', { companyName: '  ', fullName: 'User', email: 'user@example.com', password: 'password1' }],
    ['unknown field', { companyName: 'Folio', fullName: 'User', email: 'user@example.com', password: 'password1', extra: true }],
  ])('rejects %s', (description, body) => {
    expect(() => registerSchema.parse({ ...emptyRequest, body })).toThrow();
  });

  test('rejects unknown login fields', () => {
    expect(() => loginSchema.parse({
      ...emptyRequest,
      body: { email: 'user@example.com', password: 'password1', extra: true },
    })).toThrow();
  });

  test('accepts an empty request for the current-user endpoint', () => {
    expect(getCurrentUserSchema.parse({ ...emptyRequest, body: {} })).toEqual({
      ...emptyRequest,
      body: {},
    });
  });
});
