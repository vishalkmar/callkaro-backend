const { errors } = require('../utils/response');

/**
 * validate({ body, query, params }) - each a Joi schema. Unknown keys are stripped,
 * validated values replace the originals.
 */
const validate = schemas => (req, res, next) => {
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) {
      continue;
    }
    const { error, value } = schemas[part].validate(req[part] || {}, { abortEarly: true, stripUnknown: true, convert: true });
    if (error) {
      return next(errors.badRequest('VALIDATION_ERROR', error.details[0].message.replace(/"/g, '')));
    }
    if (part === 'query') {
      // Express 5: req.query is a getter - override with a plain property
      Object.defineProperty(req, 'query', { value, writable: true, configurable: true, enumerable: true });
    } else {
      req[part] = value;
    }
  }
  return next();
};

module.exports = validate;
