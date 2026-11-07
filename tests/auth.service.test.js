jest.mock('../src/config/db', () => ({
  pool: { query: jest.fn() },
  withTransaction: jest.fn(),
}));

jest.mock('../src/services/chart-of-accounts.service', () => ({
  seedDefaultAccounts: jest.fn(),
}));

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, withTransaction } = require('../src/config/db');
const { seedDefaultAccounts } = require('../src/services/chart-of-accounts.service');
const {
  getCurrentUser,
  register,
  login,
} = require('../src/services/auth.service');

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JWT_SECRET = 'test-secret-with-at-least-thirty-two-characters';

const registrationInput = {
  companyName: '  Folio Test Company  ',
  fullName: '  Test User  ',
  email: '  User@Example.com ',
  password: 'a-valid-test-password',
};

function createTransactionClient({ userError } = {}) {
  const query = jest.fn()
    .mockResolvedValueOnce({
      rows: [{
        id: COMPANY_ID,
        name: 'Folio Test Company',
        baseCurrency: 'MYR',
        createdAt: '2026-11-07T00:00:00.000Z',
      }],
    })
    .mockImplementationOnce(async () => {
      if (userError) {
        throw userError;
      }

      return {
        rows: [{
          id: USER_ID,
          companyId: COMPANY_ID,
          email: 'user@example.com',
          fullName: 'Test User',
          createdAt: '2026-11-07T00:00:00.000Z',
        }],
      };
    });

  const client = { query };
  withTransaction.mockImplementation((callback) => callback(client));
  return client;
}

function createLoginUser(overrides = {}) {
  return {
    id: USER_ID,
    companyId: COMPANY_ID,
    email: 'user@example.com',
    fullName: 'Test User',
    passwordHash: bcrypt.hashSync('correct-password', 4),
    ...overrides,
  };
}

describe('auth service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.JWT_EXPIRES_IN = '2h';
  });

  describe('register', () => {
    test('creates a normalized user and company in one transaction and seeds accounts', async () => {
      const client = createTransactionClient();

      const result = await register(registrationInput);

      expect(withTransaction).toHaveBeenCalledTimes(1);
      expect(client.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('INSERT INTO companies'),
        ['Folio Test Company'],
      );
      expect(client.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('INSERT INTO users'),
        [
          COMPANY_ID,
          'user@example.com',
          expect.any(String),
          'Test User',
        ],
      );
      const storedHash = client.query.mock.calls[1][1][2];
      expect(storedHash).not.toBe(registrationInput.password);
      expect(storedHash).toMatch(/^\$2[ab]\$12\$/);
      expect(await bcrypt.compare(registrationInput.password, storedHash)).toBe(true);
      expect(seedDefaultAccounts).toHaveBeenCalledWith(client, COMPANY_ID);
      expect(result.user).not.toHaveProperty('password_hash');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result).toMatchObject({
        user: { id: USER_ID, email: 'user@example.com', fullName: 'Test User' },
        company: { id: COMPANY_ID, name: 'Folio Test Company' },
      });
    });

    test('returns EMAIL_IN_USE for a duplicate email', async () => {
      const duplicateError = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'idx_users_email_lower',
      });
      createTransactionClient({ userError: duplicateError });

      await expect(register(registrationInput)).rejects.toMatchObject({
        statusCode: 409,
        code: 'EMAIL_IN_USE',
      });
      expect(seedDefaultAccounts).not.toHaveBeenCalled();
    });

    test('propagates unexpected transaction failures', async () => {
      const databaseError = new Error('database unavailable');
      withTransaction.mockRejectedValue(databaseError);

      await expect(register(registrationInput)).rejects.toBe(databaseError);
    });
  });

  describe('login', () => {
    test('returns a signed JWT containing only the user id and an expiry', async () => {
      const user = createLoginUser();
      pool.query.mockResolvedValue({ rows: [user] });

      const result = await login({ email: '  USER@example.com ', password: 'correct-password' });
      const payload = jwt.verify(result.token, JWT_SECRET, { algorithms: ['HS256'] });

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM users'),
        ['user@example.com'],
      );
      expect(payload).toEqual(expect.objectContaining({ sub: USER_ID, exp: expect.any(Number) }));
      expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.user).not.toHaveProperty('password_hash');
      expect(result.user).toMatchObject({ id: USER_ID, email: 'user@example.com' });
    });

    test('returns the standard authentication error for an incorrect password', async () => {
      pool.query.mockResolvedValue({ rows: [createLoginUser()] });

      await expect(login({ email: 'user@example.com', password: 'wrong-password' }))
        .rejects.toMatchObject({
          statusCode: 401,
          code: 'UNAUTHENTICATED',
          message: 'Invalid email or password',
        });
    });

    test('returns the same authentication error for an unknown email', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await expect(login({ email: 'unknown@example.com', password: 'wrong-password' }))
        .rejects.toMatchObject({
          statusCode: 401,
          code: 'UNAUTHENTICATED',
          message: 'Invalid email or password',
        });
    });

    describe('getCurrentUser', () => {
        test('returns the authenticated user and company without querying a password hash', async () => {
          pool.query.mockResolvedValue({
            rows: [{
              id: USER_ID,
              email: 'user@example.com',
              fullName: 'Test User',
              companyId: COMPANY_ID,
              companyName: 'Folio Test Company',
              baseCurrency: 'MYR',
            }],
          });

          await expect(getCurrentUser(USER_ID)).resolves.toEqual({
            user: {
              id: USER_ID,
              email: 'user@example.com',
              fullName: 'Test User',
            },
            company: {
              id: COMPANY_ID,
              name: 'Folio Test Company',
              baseCurrency: 'MYR',
            },
          });
          expect(pool.query).toHaveBeenCalledWith(
            expect.not.stringContaining('password_hash'),
            [USER_ID],
          );
        });

        test('returns an authentication error if the user no longer exists', async () => {
          pool.query.mockResolvedValue({ rows: [] });

          await expect(getCurrentUser(USER_ID)).rejects.toMatchObject({
            statusCode: 401,
            code: 'UNAUTHENTICATED',
          });
        });

        test('propagates database failures', async () => {
          const databaseError = new Error('Database unavailable');
          pool.query.mockRejectedValue(databaseError);

          await expect(getCurrentUser(USER_ID)).rejects.toBe(databaseError);
        });
    });
  });
});
