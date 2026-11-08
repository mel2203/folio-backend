const { ZodError } = require('zod');
const { AppError } = require('../errors');

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }

  if (error.status === 400 && error.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'Malformed JSON request body',
        details: [],
      },
    });
  }

  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details || [],
      },
    });
  }

//delete after testing
  if (process.env.NODE_ENV !== 'production') {
    console.error('Unhandled error:', error.code, error.message);
  }




  return res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      details: [],
    },
  });
}

module.exports = errorHandler;
