import 'dotenv/config';
import { createServer } from 'node:http';
import { z } from 'zod';
import { createApp } from './app.js';
import { createMysqlPool, createMysqlRepositories, FirestoreAdminContentRepository } from './database.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_NAME: z.string().regex(/^[A-Za-z0-9_]+$/),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  JWT_SECRET: z.string().min(64, 'JWT_SECRET must contain at least 64 characters.'),
  JWT_EXPIRES_IN: z.string().default('2h'),
  CORS_ORIGINS: z.string().default('http://localhost:4200,http://127.0.0.1:4200,http://localhost:8100,http://localhost,https://localhost,capacitor://localhost'),
  SMS_PROVIDER: z.enum(['semaphore']).default('semaphore'),
  SMS_API_URL: z.string().url().default('https://api.semaphore.co/api/v4/messages'),
  SMS_API_KEY: z.string().default(''),
  SMS_SENDER_NAME: z.string().max(11).default(''),
  FIREBASE_PROJECT_ID: z.string().default('resq-it')
    .transform((value) => value.trim() || 'resq-it')
    .pipe(z.literal('resq-it'))
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Backend configuration is invalid:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}
const config = parsed.data;

if (config.JWT_SECRET.toLowerCase().includes('replace') || config.JWT_SECRET.toLowerCase().includes('example')) {
  console.error('JWT_SECRET must be a unique randomly generated secret, not a placeholder.');
  process.exit(1);
}

const pool = createMysqlPool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD
});
const repositories = createMysqlRepositories(pool);
const app = createApp({
  ...repositories,
  content: new FirestoreAdminContentRepository(),
  jwtSecret: config.JWT_SECRET,
  jwtExpiresIn: config.JWT_EXPIRES_IN,
  corsOrigins: config.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  verifyFirebaseIdToken: async (token) => {
    const { applicationDefault, getApps, initializeApp } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const firebaseApp = getApps()[0] ?? initializeApp({
      credential: applicationDefault(),
      ...(config.FIREBASE_PROJECT_ID ? { projectId: config.FIREBASE_PROJECT_ID } : {})
    });
    const identity = await getAuth(firebaseApp).verifyIdToken(token, true);
    return {
      uid: identity.uid,
      admin: identity.admin === true,
      ...(identity.email ? { email: identity.email } : {}),
      ...(identity.name ? { name: identity.name } : {})
    };
  }
});
const server = createServer(app);

try {
  await pool.query('SELECT 1');
  server.listen(config.PORT, config.HOST, () => {
    console.log(`ResQ-It API listening on http://${config.HOST}:${config.PORT}`);
  });
} catch (error) {
  await pool.end();
  console.error('Could not connect to MySQL. Check the backend .env database settings.', error);
  process.exit(1);
}

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received; shutting down ResQ-It API.`);
  server.close(async (error) => {
    await pool.end();
    if (error) {
      console.error('Could not close the API server cleanly.', error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
