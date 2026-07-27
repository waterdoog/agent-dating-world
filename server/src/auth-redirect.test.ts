import assert from 'node:assert/strict';
import test from 'node:test';
import { authResultUrl, normalizeReturnTo } from './auth-redirect.js';

test('normalizeReturnTo accepts only known local world routes', () => {
  assert.equal(normalizeReturnTo('/'), '/');
  assert.equal(normalizeReturnTo('/world'), '/world');
  assert.equal(normalizeReturnTo('/world/'), '/world');
  assert.equal(normalizeReturnTo('/fights'), '/fights');
  assert.equal(normalizeReturnTo('/fights/'), '/fights');
  assert.equal(normalizeReturnTo('/design?section=components'), '/design');
  assert.equal(normalizeReturnTo('/profile'), '/profile');
  assert.equal(normalizeReturnTo('/leaderboard'), '/leaderboard');
  assert.equal(normalizeReturnTo('/leaderboard/'), '/leaderboard');
  assert.equal(normalizeReturnTo('/leaderboard?scope=credits'), '/leaderboard');
});

test('normalizeReturnTo rejects external and malformed destinations', () => {
  for (const value of [
    undefined,
    '',
    'https://evil.example/fights',
    '//evil.example',
    '/%2f%2fevil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '/unknown',
  ]) {
    assert.equal(normalizeReturnTo(value), '/');
  }
});

test('authResultUrl returns to the stored route after success', () => {
  assert.equal(
    authResultUrl('http://localhost:3000', '/fights', { login: 'ok' }),
    'http://localhost:3000/fights?login=ok'
  );
});

test('authResultUrl encodes provider errors and falls back safely', () => {
  assert.equal(
    authResultUrl('http://localhost:3000/', '//evil.example', { loginError: 'access denied' }),
    'http://localhost:3000/?login_error=access+denied'
  );
});
