import bcrypt from 'bcryptjs';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { z, ZodError } from 'zod';
import type {
  AccountRepository, AdminContentRepository, ContentCollection, NewFacilitySuggestion,
  NewReport, PublicUser, ReportStatus, SuggestionStatus, UserRecord
} from './types.js';

declare global {
  namespace Express {
    interface Request {
      authUser?: PublicUser;
      firebaseAdmin?: boolean;
    }
  }
}

const RESQ_IT_ADMIN_UID = '279f5QypzDUvSe7diQl1AqlbUYK2';

interface AppOptions {
  accounts: AccountRepository;
  privateRecords: import('./types.js').PrivateRecordRepository;
  content: AdminContentRepository;
  jwtSecret: string;
  jwtExpiresIn: string;
  corsOrigins: string[];
  verifyFirebaseIdToken?: (token: string) => Promise<{
    uid: string;
    admin: boolean;
    email?: string;
    name?: string;
  }>;
}

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const optionalText = (max: number) => z.string().trim().max(max).optional().default('');
const registerSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: z.string().min(8).max(72),
  phoneNumber: optionalText(40),
  emergencyContactName: optionalText(120),
  emergencyContactNumber: optionalText(40)
}).strict();
const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(72)
}).strict();
const profileSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  phoneNumber: optionalText(40),
  emergencyContactName: optionalText(120),
  emergencyContactNumber: optionalText(40)
}).strict();
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: z.string().min(8).max(72)
}).strict();
const reportSchema = z.object({
  category: z.enum(['medical', 'fire', 'police', 'accident', 'disaster', 'other']),
  description: z.string().trim().max(2000).optional(),
  latitude: z.number().finite().min(-90).max(90).optional(),
  longitude: z.number().finite().min(-180).max(180).optional()
}).strict();
const suggestionSchema = z.object({
  facilityName: z.string().trim().min(1).max(200),
  facilityType: z.string().trim().min(1).max(80),
  address: z.string().trim().max(300).optional(),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  contactNumber: z.string().trim().max(40).optional(),
  sourceUrl: z.union([z.string().url().max(2048), z.literal('')]).optional()
}).strict();
const reportStatusSchema = z.object({
  status: z.enum(['Submitted', 'Under Review', 'Resolved', 'Closed'])
}).strict();
const reviewSuggestionSchema = z.object({
  reviewStatus: z.enum(['approved', 'rejected']),
  reviewNote: z.string().trim().max(1000).optional().default('')
}).strict();
const categorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  description: z.string().trim().max(1000),
  icon: z.string().trim().min(1).max(80),
  facilityTypes: z.array(z.string().trim().min(1).max(80)).max(30),
  isActive: z.boolean(),
  displayOrder: z.number().int().min(0).max(100000)
}).strict();
const hotlineSchema = z.object({
  name: z.string().trim().min(1).max(160),
  phoneNumber: z.string().trim().min(1).max(40),
  countryCode: z.string().trim().min(1).max(8),
  region: z.string().trim().min(1).max(120),
  category: z.enum(['medical', 'fire', 'police', 'accident', 'disaster', 'other']),
  description: z.string().trim().max(1000),
  officialSourceUrl: z.string().url().max(2048),
  verificationStatus: z.enum(['verified', 'unverified']),
  isActive: z.boolean()
}).strict();
const guideSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.enum(['medical', 'fire', 'police', 'accident', 'disaster', 'other']),
  summary: z.string().trim().min(1).max(1000),
  instructions: z.string().trim().min(1).max(10000),
  sourceUrl: z.string().url().max(2048),
  isPublished: z.boolean()
}).strict();

function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    phoneNumber: user.phoneNumber ?? '',
    emergencyContactName: user.emergencyContactName ?? '',
    emergencyContactNumber: user.emergencyContactNumber ?? ''
  };
}

function validationError(error: ZodError): { fields: Record<string, string[]> } {
  return { fields: z.flattenError(error).fieldErrors as Record<string, string[]> };
}

function isDuplicateEmail(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === 'ER_DUP_ENTRY';
}

function readBody<T>(schema: z.ZodType<T>, request: Request, response: Response): T | null {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Check the submitted fields and try again.',
      details: validationError(parsed.error)
    });
    return null;
  }
  return parsed.data;
}

function requireUser(request: Request): PublicUser {
  if (!request.authUser) throw new Error('Authentication middleware did not set the user.');
  return request.authUser;
}

function isFirebaseIdToken(token: string): boolean {
  try {
    const payload = token.split('.')[1];
    if (!payload) return false;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iss?: unknown };
    return typeof decoded.iss === 'string'
      && decoded.iss.startsWith('https://securetoken.google.com/');
  } catch {
    return false;
  }
}

function getContentSchema(collection: ContentCollection): z.ZodType<Record<string, unknown>> {
  const schema = collection === 'emergencyCategories'
    ? categorySchema
    : collection === 'emergencyHotlines'
      ? hotlineSchema
      : guideSchema;
  return schema as z.ZodType<Record<string, unknown>>;
}

export function createApp(options: AppOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || options.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin is not allowed by CORS.'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
  app.use(express.json({ limit: '32kb', strict: true }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: 'Too many authentication attempts. Try again later.' }
  });
  const authenticate: express.RequestHandler = async (request, response, next) => {
    try {
      const authorization = request.header('authorization');
      const match = authorization?.match(/^Bearer ([^\s]+)$/i);
      if (!match) {
        response.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication is required.' });
        return;
      }
      if (options.verifyFirebaseIdToken && isFirebaseIdToken(match[1])) {
        try {
          const identity = await options.verifyFirebaseIdToken(match[1]);
          if (identity.uid !== RESQ_IT_ADMIN_UID || !identity.admin) {
            response.status(401).json({ error: 'UNAUTHORIZED', message: 'The session is invalid or expired.' });
            return;
          }
          request.authUser = {
            id: 0,
            fullName: identity.name ?? '',
            email: identity.email ?? '',
            role: 'admin',
            phoneNumber: '',
            emergencyContactName: '',
            emergencyContactNumber: ''
          };
          request.firebaseAdmin = true;
          next();
          return;
        } catch (firebaseError) {
          if (
            typeof firebaseError === 'object'
            && firebaseError !== null
            && 'code' in firebaseError
            && typeof firebaseError.code === 'string'
            && !firebaseError.code.startsWith('auth/')
          ) {
            next(firebaseError);
            return;
          }
        }
      }
      const decoded = jwt.verify(match[1], options.jwtSecret, {
        algorithms: ['HS256'],
        issuer: 'resq-it-api',
        audience: 'resq-it-client'
      });
      if (typeof decoded === 'string' || !decoded.sub || !/^\d+$/.test(decoded.sub)) {
        response.status(401).json({ error: 'UNAUTHORIZED', message: 'The session is invalid or expired.' });
        return;
      }
      const user = await options.accounts.findUserById(Number(decoded.sub));
      if (!user || !user.isActive || decoded.ver !== user.tokenVersion) {
        response.status(401).json({ error: 'UNAUTHORIZED', message: 'The session is invalid or expired.' });
        return;
      }
      request.authUser = publicUser(user);
      next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
        response.status(401).json({ error: 'UNAUTHORIZED', message: 'The session is invalid or expired.' });
        return;
      }
      next(error);
    }
  };
  const requireAdmin: express.RequestHandler = (request, response, next) => {
    if (!request.firebaseAdmin) {
      response.status(403).json({ error: 'FORBIDDEN', message: 'Administrator access is required.' });
      return;
    }
    next();
  };
  const signToken = (user: UserRecord): string => jwt.sign(
    { ver: user.tokenVersion },
    options.jwtSecret,
    {
      algorithm: 'HS256',
      subject: String(user.id),
      issuer: 'resq-it-api',
      audience: 'resq-it-client',
      expiresIn: options.jwtExpiresIn as jwt.SignOptions['expiresIn']
    }
  );

  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));

  app.post('/api/auth/register', authLimiter, async (request, response, next) => {
    const input = readBody(registerSchema, request, response);
    if (!input) return;
    if (Buffer.byteLength(input.password, 'utf8') > 72) {
      response.status(400).json({ error: 'VALIDATION_ERROR', message: 'Password must be at most 72 UTF-8 bytes.' });
      return;
    }
    try {
      const passwordHash = await bcrypt.hash(input.password, 12);
      const user = await options.accounts.createUser({ ...input, passwordHash });
      response.status(201).json({ token: signToken(user), user: publicUser(user) });
    } catch (error) {
      if (isDuplicateEmail(error)) {
        response.status(409).json({ error: 'EMAIL_IN_USE', message: 'An account with this email already exists.' });
        return;
      }
      next(error);
    }
  });

  app.post('/api/auth/login', authLimiter, async (request, response, next) => {
    const input = readBody(loginSchema, request, response);
    if (!input) return;
    try {
      const user = await options.accounts.findUserByEmail(input.email);
      const passwordMatches = user ? await bcrypt.compare(input.password, user.passwordHash) : false;
      if (!user || !user.isActive || !passwordMatches) {
        response.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
        return;
      }
      response.json({ token: signToken(user), user: publicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/me', authenticate, (request, response) => {
    response.json({ user: requireUser(request) });
  });

  app.put('/api/users/profile', authenticate, async (request, response, next) => {
    const input = readBody(profileSchema, request, response);
    if (!input) return;
    try {
      const user = await options.accounts.updateProfile(requireUser(request).id, input);
      response.json({ user: publicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/users/change-password', authenticate, async (request, response, next) => {
    const input = readBody(changePasswordSchema, request, response);
    if (!input) return;
    if (Buffer.byteLength(input.newPassword, 'utf8') > 72) {
      response.status(400).json({ error: 'VALIDATION_ERROR', message: 'Password must be at most 72 UTF-8 bytes.' });
      return;
    }
    try {
      const user = await options.accounts.findUserById(requireUser(request).id);
      if (!user || !(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
        response.status(400).json({ error: 'INVALID_PASSWORD', message: 'Current password is incorrect.' });
        return;
      }
      const passwordHash = await bcrypt.hash(input.newPassword, 12);
      await options.accounts.changePassword(user.id, passwordHash);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/account/reports', authenticate, async (request, response, next) => {
    try {
      response.json({ items: await options.privateRecords.getReportsForUser(requireUser(request).id) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/account/reports', authenticate, async (request, response, next) => {
    const input = readBody(reportSchema, request, response) as NewReport | null;
    if (!input) return;
    try {
      const reportId = await options.privateRecords.createReport(requireUser(request).id, input);
      response.status(201).json({ reportId });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/account/facility-suggestions', authenticate, async (request, response, next) => {
    const input = readBody(suggestionSchema, request, response) as NewFacilitySuggestion | null;
    if (!input) return;
    try {
      const suggestionId = await options.privateRecords.createFacilitySuggestion(requireUser(request).id, input);
      response.status(201).json({ suggestionId });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/dashboard', authenticate, requireAdmin, async (_request, response, next) => {
    try {
      const [categories, hotlines, guides] = await Promise.all([
        options.content.getAll('emergencyCategories'),
        options.content.getAll('emergencyHotlines'),
        options.content.getAll('emergencyGuides')
      ]);
      response.json({ categories, hotlines, guides });
    } catch (error) {
      next(error);
    }
  });

  const collections: ContentCollection[] = ['emergencyCategories', 'emergencyHotlines', 'emergencyGuides'];
  for (const collection of collections) {
    const routeName = collection === 'emergencyCategories'
      ? 'categories'
      : collection === 'emergencyHotlines' ? 'hotlines' : 'guides';
    const schema = getContentSchema(collection);
    app.get(`/api/admin/${routeName}`, authenticate, requireAdmin, async (_request, response, next) => {
      try {
        response.json({ items: await options.content.getAll(collection) });
      } catch (error) {
        next(error);
      }
    });
    app.post(`/api/admin/${routeName}`, authenticate, requireAdmin, async (request, response, next) => {
      const input = readBody(schema, request, response);
      if (!input) return;
      try {
        const record = collection === 'emergencyGuides'
          ? { ...input, reviewedBy: requireUser(request).email }
          : collection === 'emergencyHotlines'
            ? { ...input, lastVerifiedAt: input.verificationStatus === 'verified' ? new Date().toISOString() : null }
            : input;
        const savedId = await options.content.save(collection, record);
        response.status(201).json({ id: savedId });
      } catch (error) {
        next(error);
      }
    });
    app.put(`/api/admin/${routeName}/:id`, authenticate, requireAdmin, async (request, response, next) => {
      const input = readBody(schema, request, response);
      if (!input) return;
      try {
        const record = collection === 'emergencyGuides'
          ? { ...input, reviewedBy: requireUser(request).email }
          : collection === 'emergencyHotlines'
            ? { ...input, lastVerifiedAt: input.verificationStatus === 'verified' ? new Date().toISOString() : null }
            : input;
        await options.content.save(collection, record, String(request.params.id));
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    });
    app.delete(`/api/admin/${routeName}/:id`, authenticate, requireAdmin, async (request, response, next) => {
      try {
        await options.content.delete(collection, String(request.params.id));
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    });
  }

  app.get('/api/admin/reports', authenticate, requireAdmin, async (_request, response, next) => {
    try {
      response.json({ items: await options.privateRecords.getAllReports() });
    } catch (error) {
      next(error);
    }
  });
  app.patch('/api/admin/reports/:id', authenticate, requireAdmin, async (request, response, next) => {
    const input = readBody(reportStatusSchema, request, response) as { status: ReportStatus } | null;
    if (!input) return;
    try {
      if (!(await options.privateRecords.updateReportStatus(String(request.params.id), input.status))) {
        response.status(404).json({ error: 'NOT_FOUND', message: 'Report was not found.' });
        return;
      }
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/admin/facility-suggestions', authenticate, requireAdmin, async (_request, response, next) => {
    try {
      response.json({ items: await options.privateRecords.getAllFacilitySuggestions() });
    } catch (error) {
      next(error);
    }
  });
  app.patch('/api/admin/facility-suggestions/:id', authenticate, requireAdmin, async (request, response, next) => {
    const input = readBody(reviewSuggestionSchema, request, response) as {
      reviewStatus: SuggestionStatus;
      reviewNote: string;
    } | null;
    if (!input) return;
    try {
      if (!(await options.privateRecords.reviewFacilitySuggestion(
        String(request.params.id), input.reviewStatus, input.reviewNote
      ))) {
        response.status(404).json({ error: 'NOT_FOUND', message: 'Facility suggestion was not found.' });
        return;
      }
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use((_request, response) => {
    response.status(404).json({ error: 'NOT_FOUND', message: 'API endpoint not found.' });
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof Error && error.message === 'Origin is not allowed by CORS.') {
      response.status(403).json({ error: 'CORS_ORIGIN_DENIED', message: 'This application origin is not allowed.' });
      return;
    }
    console.error('API request failed:', error);
    response.status(500).json({ error: 'INTERNAL_ERROR', message: 'The server could not complete this request.' });
  };
  app.use(errorHandler);
  return app;
}

export type VerifiedJwt = JwtPayload;
