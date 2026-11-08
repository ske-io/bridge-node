import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mailTransport } from '@ske-io/bridge';

import { PLATFORM, useEnv } from './helpers.ts';

const CATCHER = { MAIL_MAILER: 'smtp', MAIL_HOST: '127.0.0.1', MAIL_PORT: '2525', MAIL_ENCRYPTION: '' };
const OWN = { host: 'smtp.example.com', port: 587, auth: { user: 'me', pass: 'pw' } };

test("the platform's catcher replaces the app's SMTP server, with no TLS and no login", () => {
  useEnv({ ...PLATFORM, ...CATCHER, MAIL_USERNAME: 'stale', MAIL_PASSWORD: 'stale' });
  const expected = { host: '127.0.0.1', port: 2525, secure: false, ignoreTLS: true };
  assert.deepEqual(mailTransport(), expected);
  assert.deepEqual(mailTransport(OWN), expected);
});

test("off the platform, or without the platform's SMTP mailer, the app's own settings are used", () => {
  useEnv({ ...CATCHER });
  assert.equal(mailTransport(OWN), OWN);
  assert.equal(mailTransport(), undefined);

  useEnv({ ...PLATFORM, ...CATCHER, MAIL_MAILER: 'ses' });
  assert.equal(mailTransport(OWN), OWN);

  useEnv({ ...PLATFORM, ...CATCHER, MAIL_PORT: 'smtp' });
  assert.equal(mailTransport(OWN), OWN);
});

test('an encrypted SMTP server keeps TLS and its login', () => {
  useEnv({ ...PLATFORM, ...CATCHER, MAIL_HOST: 'mail.example.com', MAIL_PORT: '587', MAIL_ENCRYPTION: 'tls', MAIL_USERNAME: 'u', MAIL_PASSWORD: 'p' });
  assert.deepEqual(mailTransport(), { host: 'mail.example.com', port: 587, secure: false, requireTLS: true, auth: { user: 'u', pass: 'p' } });

  useEnv({ ...PLATFORM, ...CATCHER, MAIL_PORT: '465', MAIL_ENCRYPTION: 'ssl', MAIL_USERNAME: undefined, MAIL_PASSWORD: undefined });
  assert.deepEqual(mailTransport(), { host: '127.0.0.1', port: 465, secure: true });
});
