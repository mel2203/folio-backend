require('dotenv').config({ quiet: true });

if (process.env.NODE_ENV !== 'test') {
  throw new Error('Tests may only run when NODE_ENV=test');
}

if (
  !process.env.DATABASE_URL_TEST
  || process.env.DATABASE_URL_TEST === process.env.DATABASE_URL
) {
  throw new Error('Set DATABASE_URL_TEST to a database URL distinct from DATABASE_URL before testing');
}

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production-000000';
process.env.JWT_EXPIRES_IN = '2h';
