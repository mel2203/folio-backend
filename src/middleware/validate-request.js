const { ZodError } = require('zod');

function validateRequest(schema) {
  return (req, res, next) => {
    try {
      req.validated = schema.parse({
        body: req.body,
        params: req.params,
        query: req.query,
      });
      return next();
    } catch (error) {
      if (error instanceof ZodError) {
        return next(error);
      }

      return next(error);
    }
  };
}

module.exports = validateRequest;
