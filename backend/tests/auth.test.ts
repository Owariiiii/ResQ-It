import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestApi } from './test-support.js';

test('registration creates a regular account, rejects duplicate email, and never returns the hash', async () => {
  const { api } = await createTestApi();
  const registration = await api.post('/api/auth/register').send({
    fullName: '  Sam Responder ',
    email: 'SAM@example.com',
    password: 'SecurePass123!'
  });

  assert.equal(registration.status, 201);
  assert.equal(registration.body.user.fullName, 'Sam Responder');
  assert.equal(registration.body.user.email, 'sam@example.com');
  assert.equal(registration.body.user.role, 'user');
  assert.equal('passwordHash' in registration.body.user, false);
  assert.equal('password' in registration.body.user, false);
  assert.equal(typeof registration.body.token, 'string');

  const duplicate = await api.post('/api/auth/register').send({
    fullName: 'Different Name',
    email: 'sam@example.com',
    password: 'AnotherPass123!'
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, 'EMAIL_IN_USE');

  const attemptedPromotion = await api.post('/api/auth/register').send({
    fullName: 'Self Promoter',
    email: 'admin-attempt@example.com',
    password: 'SecurePass123!',
    role: 'admin'
  });
  assert.equal(attemptedPromotion.status, 400);
});

test('login returns the same generic error for unknown email and incorrect password', async () => {
  const { api } = await createTestApi();
  await api.post('/api/auth/register').send({
    fullName: 'Login User',
    email: 'login@example.com',
    password: 'SecurePass123!'
  });

  const wrongPassword = await api.post('/api/auth/login').send({
    email: 'login@example.com',
    password: 'WrongPass123!'
  });
  const unknownEmail = await api.post('/api/auth/login').send({
    email: 'missing@example.com',
    password: 'WrongPass123!'
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.equal(wrongPassword.body.message, unknownEmail.body.message);
});

test('register validates required fields and password strength', async () => {
  const { api } = await createTestApi();
  const response = await api.post('/api/auth/register').send({
    fullName: '',
    email: 'not-an-email',
    password: 'short'
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'VALIDATION_ERROR');
});
