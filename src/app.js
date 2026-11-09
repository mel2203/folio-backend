require('dotenv').config({ quiet: true });

if (typeof process.env.JWT_SECRET !== 'string' || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set and at least 32 characters');
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const accountRoutes = require('./routes/account.routes');
const journalRoutes = require('./routes/journal.routes');
const authRoutes = require('./routes/auth.routes');
const reportRoutes = require('./routes/report.routes');
const authenticate = require('./middleware/authenticate');
const errorHandler = require('./middleware/error-handler');

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(helmet());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api', authenticate);
app.use('/api/accounts', accountRoutes);
app.use('/api/journal-entries', journalRoutes);
app.use('/api/reports', reportRoutes);
app.use(errorHandler);

module.exports = app;
