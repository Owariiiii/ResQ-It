import 'dotenv/config';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const RESQ_IT_ADMIN_UID = '279f5QypzDUvSe7diQl1AqlbUYK2';
const FIREBASE_PROJECT_ID = 'resq-it';
const uid = process.argv[2]?.trim();

if (process.env.FIREBASE_PROJECT_ID !== FIREBASE_PROJECT_ID) {
  console.error(`Set FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID} in backend/.env before granting the administrator claim.`);
  process.exitCode = 1;
} else if (uid !== RESQ_IT_ADMIN_UID) {
  console.error(`From the backend folder run: node --import tsx scripts/grant-admin.ts ${RESQ_IT_ADMIN_UID}`);
  process.exitCode = 1;
} else {
  try {
    const app = getApps()[0] ?? initializeApp({
      credential: applicationDefault(),
      projectId: FIREBASE_PROJECT_ID
    });
    const auth = getAuth(app);
    const user = await auth.getUser(uid);
    await auth.setCustomUserClaims(uid, { ...user.customClaims, admin: true });
    console.log(`Administrator claim granted to the existing Firebase UID ${uid}.`);
    console.log('The user must sign out and sign in again to refresh their ID token.');
  } catch (error) {
    console.error('Could not grant the administrator claim.', error);
    process.exitCode = 1;
  }
}
