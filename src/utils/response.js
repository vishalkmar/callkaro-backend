// Standard envelopes: { success: true, data } | { success: false, code, message }

class AppError extends Error {
  constructor(status, code, message, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const ok = (res, data = null, status = 200) => res.status(status).json({ success: true, data });

const errors = {
  badRequest: (code = 'BAD_REQUEST', msg = 'Invalid request', data) => new AppError(400, code, msg, data),
  unauthorized: (code = 'UNAUTHORIZED', msg = 'Please login again') => new AppError(401, code, msg),
  forbidden: (code = 'FORBIDDEN', msg = 'Not allowed') => new AppError(403, code, msg),
  notFound: (code = 'NOT_FOUND', msg = 'Not found') => new AppError(404, code, msg),
  conflict: (code = 'CONFLICT', msg = 'Conflict', data) => new AppError(409, code, msg, data),
  tooMany: (code = 'TOO_MANY_REQUESTS', msg = 'Too many requests, slow down', data) => new AppError(429, code, msg, data),
  payment: (code = 'INSUFFICIENT_CREDITS', msg = 'Not enough credits', data) => new AppError(402, code, msg, data),
  unavailable: (code = 'SERVICE_UNAVAILABLE', msg = 'Service unavailable, try later') => new AppError(503, code, msg),
};

module.exports = { AppError, ok, errors };
