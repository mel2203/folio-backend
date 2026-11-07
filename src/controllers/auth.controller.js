const { login, register, getCurrentUser } = require('../services/auth.service');

async function registerUser(req, res) {
  const result = await register(req.validated.body);
  res.status(201).json({ data: result });
}

async function loginUser(req, res) {
  const result = await login(req.validated.body);
  res.status(200).json({ data: result });
}

async function getMe(req, res) {
  const result = await getCurrentUser(req.user.id);
  res.status(200).json({ data: result });
}

module.exports = { registerUser, loginUser, getMe };
