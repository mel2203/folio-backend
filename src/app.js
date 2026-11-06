require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const accountRoutes = require('./routes/account.routes');
const journalRoutes = require('./routes/journal.routes');
const companyContext = require('./middleware/company-context');
const errorHandler = require('./middleware/error-handler');

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api', companyContext);
app.use('/api/accounts', accountRoutes);
app.use('/api/journal-entries', journalRoutes);
app.use(errorHandler);

module.exports = app;
