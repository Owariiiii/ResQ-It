import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccount, createTestApi } from './test-support.js';

test('profile endpoints require authentication and only return the caller account', async () => {
  const { api } = await createTestApi();
  const first = await createAccount(api, 'first@example.com');
  const second = await createAccount(api, 'second@example.com');

  assert.equal((await api.get('/api/auth/me')).status, 401);
  const me = await api.get('/api/auth/me').set('Authorization', `Bearer ${first.token}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'first@example.com');

  const updated = await api.put('/api/users/profile')
    .set('Authorization', `Bearer ${first.token}`)
    .send({
      fullName: 'Updated First',
      phoneNumber: '+639171234567',
      emergencyContactName: 'Trusted Contact',
      emergencyContactNumber: '+639189876543'
    });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.user.fullName, 'Updated First');

  const otherProfile = await api.get('/api/auth/me').set('Authorization', `Bearer ${second.token}`);
  assert.equal(otherProfile.body.user.fullName, 'Test User');
  assert.equal(otherProfile.body.user.email, 'second@example.com');
});

test('password change verifies the current password and revokes the previous token', async () => {
  const { api } = await createTestApi();
  const account = await createAccount(api, 'password@example.com');
  const failedChange = await api.put('/api/users/change-password')
    .set('Authorization', `Bearer ${account.token}`)
    .send({ currentPassword: 'not-the-current-password', newPassword: 'BrandNewPass123!' });
  assert.equal(failedChange.status, 400);

  const changed = await api.put('/api/users/change-password')
    .set('Authorization', `Bearer ${account.token}`)
    .send({ currentPassword: 'SecurePass123!', newPassword: 'BrandNewPass123!' });
  assert.equal(changed.status, 204);
  assert.equal((await api.get('/api/auth/me').set('Authorization', `Bearer ${account.token}`)).status, 401);

  const oldLogin = await api.post('/api/auth/login').send({
    email: 'password@example.com',
    password: 'SecurePass123!'
  });
  const newLogin = await api.post('/api/auth/login').send({
    email: 'password@example.com',
    password: 'BrandNewPass123!'
  });
  assert.equal(oldLogin.status, 401);
  assert.equal(newLogin.status, 200);
});

test('report records are scoped to the authenticated account', async () => {
  const { api } = await createTestApi();
  const first = await createAccount(api, 'reporter-one@example.com');
  const second = await createAccount(api, 'reporter-two@example.com');

  const created = await api.post('/api/account/reports')
    .set('Authorization', `Bearer ${first.token}`)
    .send({ category: 'medical', description: 'Private test report' });
  assert.equal(created.status, 201);
  const firstReports = await api.get('/api/account/reports').set('Authorization', `Bearer ${first.token}`);
  const secondReports = await api.get('/api/account/reports').set('Authorization', `Bearer ${second.token}`);
  assert.equal(firstReports.body.items.length, 1);
  assert.equal(firstReports.body.items[0].description, 'Private test report');
  assert.equal(secondReports.body.items.length, 0);
});
