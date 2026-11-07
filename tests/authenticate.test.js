jest.mock('../src/config/db', () => ({
  pool: { query: jest.fn() },
}));

const jwt = require('jsonwebtoken');
const { pool } = require('../src/config/db');
const authenticate = require('../src/middleware/authenticate');

const JWT_SECRET = 'test-secret-with-at-least-thirty-two-characters';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function createRequest(token) {
  return {
    get: jest.fn().mockReturnValue(token ? `Bearer ${token}` : undefined),
  };
}

function createResponse() {
  return {};
}

function createNext() {
  return jest.fn();
}

describe('authenticate middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = JWT_SECRET;
  });

  test('loads the user and derives companyId from the database row', async () => {
    const token = jwt.sign({ sub: USER_ID }, JWT_SECRET, { algorithm: 'HS256' });
    const req = createRequest(token);
    const next = createNext();
    pool.query.mockResolvedValue({
      rows: [{
        id: USER_ID,
        company_id: COMPANY_ID,
        email: 'user@example.com',
        full_name: 'Test User',
      }],
    });

    await authenticate(req, createResponse(), next);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id, company_id, email, full_name'),
      [USER_ID],
    );
    expect(req.user).toEqual({
      id: USER_ID,
      email: 'user@example.com',
      fullName: 'Test User',
    });
    expect(req.companyId).toBe(COMPANY_ID);
    expect(next).toHaveBeenCalledWith();
  });

  test('rejects a missing bearer token without querying users', async () => {
    const req = createRequest();
    const next = createNext();

    await authenticate(req, createResponse(), next);

    expect(pool.query).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      code: 'UNAUTHENTICATED',
    }));
  });

  test('rejects malformed or invalid tokens without querying users', async () => {
    const req = createRequest('not-a-valid-token');
    const next = createNext();

    await authenticate(req, createResponse(), next);

    expect(pool.query).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      code: 'UNAUTHENTICATED',
    }));
  });

  test('rejects a valid token when the user no longer exists', async () => {
    const token = jwt.sign({ sub: USER_ID }, JWT_SECRET, { algorithm: 'HS256' });
    const req = createRequest(token);
    const next = createNext();
    pool.query.mockResolvedValue({ rows: [] });

    await authenticate(req, createResponse(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      code: 'UNAUTHENTICATED',
    }));
  });

  test('passes database errors to the error handler', async () => {
    const token = jwt.sign({ sub: USER_ID }, JWT_SECRET, { algorithm: 'HS256' });
    const req = createRequest(token);
    const next = createNext();
    const databaseError = new Error('Database unavailable');
    pool.query.mockRejectedValue(databaseError);

    await authenticate(req, createResponse(), next);

    expect(next).toHaveBeenCalledWith(databaseError);
  });
});
