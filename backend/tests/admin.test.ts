import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccount, createTestApi } from './test-support.js';

test('database role and public registration cannot grant administrator access', async () => {
  const { api, repositories } = await createTestApi();
  const regular = await createAccount(api, 'regular@example.com');
  const legacyAdmin = await createAccount(api, 'legacy-admin@example.com');
  repositories.promoteToAdmin(legacyAdmin.user.id);

  assert.equal((await api.get('/api/admin/dashboard')
    .set('Authorization', `Bearer ${regular.token}`)).status, 403);
  assert.equal((await api.get('/api/admin/dashboard')
    .set('Authorization', `Bearer ${legacyAdmin.token}`)).status, 403);

  const registrationCannotGrantRole = await api.post('/api/auth/register').send({
    fullName: 'Self Admin',
    email: 'self-admin@example.com',
    password: 'SecurePass123!',
    role: 'admin'
  });
  assert.equal(registrationCannotGrantRole.status, 400);
});

test('only the exact Firebase admin UID with the admin claim can manage admin routes', async () => {
  const firebasePayload = Buffer.from(
    JSON.stringify({ iss: 'https://securetoken.google.com/resq-it' })
  ).toString('base64url');
  const firebaseAdminToken = `header.${firebasePayload}.signature`;
  const firebaseUserToken = `user-header.${firebasePayload}.user-signature`;
  const firebaseOtherAdminToken = `other-admin-header.${firebasePayload}.other-admin-signature`;
  const { api } = await createTestApi({
    verifyFirebaseIdToken: async (token) => {
      if (token === firebaseAdminToken) {
        return {
          uid: '279f5QypzDUvSe7diQl1AqlbUYK2',
          email: 'admin@example.com',
          admin: true
        };
      }
      if (token === firebaseUserToken) {
        return { uid: 'regular-user-uid', email: 'user@example.com', admin: false };
      }
      if (token === firebaseOtherAdminToken) {
        return { uid: 'other-uid', email: 'other@example.com', admin: true };
      }
      throw Object.assign(new Error('Invalid Firebase token'), { code: 'auth/invalid-id-token' });
    }
  });

  assert.equal((await api.get('/api/admin/dashboard')
    .set('Authorization', `Bearer ${firebaseAdminToken}`)).status, 200);
  assert.equal((await api.post('/api/admin/categories')
    .set('Authorization', `Bearer ${firebaseAdminToken}`)
    .send({
      name: 'Medical help',
      slug: 'medical-help',
      description: 'Medical facilities',
      icon: 'medical-outline',
      facilityTypes: ['hospital', 'clinic'],
      isActive: true,
      displayOrder: 1
    })).status, 201);

  assert.equal((await api.get('/api/admin/dashboard')
    .set('Authorization', `Bearer ${firebaseUserToken}`)).status, 401);
  assert.equal((await api.get('/api/admin/dashboard')
    .set('Authorization', `Bearer ${firebaseOtherAdminToken}`)).status, 401);
});

test('administrator private-data routes reject regular and missing credentials', async () => {
  const { api } = await createTestApi();
  const regular = await createAccount(api, 'user-no-admin@example.com');
  assert.equal((await api.get('/api/admin/reports')).status, 401);
  assert.equal((await api.get('/api/admin/facility-suggestions')
    .set('Authorization', `Bearer ${regular.token}`)).status, 403);
});
