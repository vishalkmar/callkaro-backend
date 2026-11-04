const { AppError } = require('../utils/response');
const logger = require('../utils/logger');
const { reportServerError } = require('../utils/crash');

const notFound = (req, res) => res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Route not found' });

// Central error handler -> { success:false, code, message }
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'Request too large' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, code: 'BAD_JSON', message: 'Invalid JSON body' });
  }
  // PostgreSQL errors that come from bad input, not from a server fault.
  if (err?.code === '22P02' || err?.code === '22003' || err?.code === '22001') {
    return res.status(400).json({ success: false, code: 'BAD_REQUEST', message: 'Invalid request' });
  }
  if (err?.code === '23505') {
    return res.status(409).json({ success: false, code: 'CONFLICT', message: 'This was already done' });
  }
  (req.log || logger).error({ err: err?.message, stack: err?.stack }, 'unhandled error');
  reportServerError(err, req);
  return res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Something went wrong, try again' });
};

module.exports = { notFound, errorHandler };
