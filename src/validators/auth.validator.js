const { z } = require('zod');

const emailSchema = z.string()
  .trim()
  .max(254)
  .email();

const passwordSchema = z.string()
  .trim()
  .min(8)
  .max(72);

const registerSchema = z.object({
  body: z.object({
    companyName: z.string().trim().min(1).max(100),
    fullName: z.string().trim().min(1).max(100),
    email: emailSchema,
    password: passwordSchema,
  }).strict(),
  params: z.object({}),
  query: z.object({}),
});

const loginSchema = z.object({
  body: z.object({
    email: emailSchema,
    password: passwordSchema,
  }).strict(),
  params: z.object({}),
  query: z.object({}),
});

const getCurrentUserSchema = z.object({
  body: z.object({}),
  params: z.object({}),
  query: z.object({}),
});

module.exports = {
  registerSchema,
  loginSchema,
  getCurrentUserSchema,
};
