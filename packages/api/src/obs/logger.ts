import pino from 'pino';

/**
 * Structured logging.
 *
 * `redact` is not decoration. Meal text and photos are health data: the text
 * can name medications or conditions, and an image can contain faces, homes,
 * or a prescription on the table. Logs are the easiest place for that to leak
 * into a system nobody classified as sensitive, so the raw payload never
 * reaches a log line — only its shape and size.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: [
      'input.text',
      'input.imageBase64',
      'req.body.text',
      'req.body.imageBase64',
      'req.headers.authorization',
      '*.imageBase64',
    ],
    censor: '[redacted]',
  },
  base: { service: 'mise-api' },
});

export type Logger = typeof logger;
