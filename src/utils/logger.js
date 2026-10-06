import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'dutylaunch-bot' },
  redact: {
    paths: [
      'authKey', 'authkey', '*.authKey', '*.authkey', 'headers.authkey',
      'req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers["x-webhook-secret"]',
      'req.headers["x-signature"]', '*.token', '*.password', '*.otp', '*.secret'
    ],
    censor: '[redacted]'
  }
});
