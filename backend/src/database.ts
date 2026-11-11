import mysql, { type Pool } from 'mysql2/promise';
import type {
  AccountRepository, AdminContentRepository, ContentCollection, NewFacilitySuggestion,
  NewReport, NewUser, PrivateRecordRepository, ReportStatus, SuggestionStatus,
  UserProfileUpdate, UserRecord
} from './types.js';

interface UserRow {
  id: number;
  full_name: string;
  email: string;
  password_hash: string;
  role: 'user' | 'admin';
  phone_number: string | null;
  emergency_contact_name: string | null;
  emergency_contact_number: string | null;
  token_version: number;
  is_active: number | boolean;
}

interface IdRow {
  id: string;
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: Number(row.id),
    fullName: row.full_name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    phoneNumber: row.phone_number,
    emergencyContactName: row.emergency_contact_name,
    emergencyContactNumber: row.emergency_contact_number,
    tokenVersion: Number(row.token_version),
    isActive: Boolean(row.is_active)
  };
}

export function createMysqlPool(options: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): Pool {
  return mysql.createPool({
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.user,
    password: options.password,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    decimalNumbers: true
  });
}

export function createMysqlRepositories(pool: Pool): {
  accounts: AccountRepository;
  privateRecords: PrivateRecordRepository;
} {
  const accounts: AccountRepository = {
    async createUser(input: NewUser): Promise<UserRecord> {
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        `INSERT INTO users
          (full_name, email, password_hash, role, phone_number, emergency_contact_name, emergency_contact_number)
         VALUES (?, ?, ?, 'user', ?, ?, ?)`,
        [
          input.fullName,
          input.email,
          input.passwordHash,
          input.phoneNumber || null,
          input.emergencyContactName || null,
          input.emergencyContactNumber || null
        ]
      );
      const user = await accounts.findUserById(result.insertId);
      if (!user) throw new Error('Created user could not be loaded from the database.');
      return user;
    },
    async findUserByEmail(email: string): Promise<UserRecord | null> {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT * FROM users WHERE email = ? LIMIT 1',
        [email]
      );
      return rows[0] ? mapUser(rows[0] as UserRow) : null;
    },
    async findUserById(id: number): Promise<UserRecord | null> {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT * FROM users WHERE id = ? LIMIT 1',
        [id]
      );
      return rows[0] ? mapUser(rows[0] as UserRow) : null;
    },
    async updateProfile(id: number, input: UserProfileUpdate): Promise<UserRecord> {
      await pool.execute(
        `UPDATE users SET full_name = ?, phone_number = ?, emergency_contact_name = ?,
         emergency_contact_number = ? WHERE id = ?`,
        [
          input.fullName,
          input.phoneNumber || null,
          input.emergencyContactName || null,
          input.emergencyContactNumber || null,
          id
        ]
      );
      const user = await accounts.findUserById(id);
      if (!user) throw new Error('Updated user could not be loaded from the database.');
      return user;
    },
    async changePassword(id: number, passwordHash: string): Promise<void> {
      await pool.execute(
        'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
        [passwordHash, id]
      );
    }
  };

  const privateRecords: PrivateRecordRepository = {
    async createReport(userId: number, input: NewReport): Promise<string> {
      const id = crypto.randomUUID();
      await pool.execute(
        `INSERT INTO emergency_reports (id, user_id, category, description, latitude, longitude)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, userId, input.category, input.description ?? null, input.latitude ?? null, input.longitude ?? null]
      );
      return id;
    },
    async getReportsForUser(userId: number): Promise<Record<string, unknown>[]> {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id AS reportId, user_id AS userId, category, description, latitude, longitude,
         status, created_at AS createdAt FROM emergency_reports WHERE user_id = ? ORDER BY created_at DESC`,
        [userId]
      );
      return rows as Record<string, unknown>[];
    },
    async getAllReports(): Promise<Record<string, unknown>[]> {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id AS reportId, user_id AS userId, category, description, latitude, longitude,
         status, created_at AS createdAt FROM emergency_reports ORDER BY created_at DESC`
      );
      return rows as Record<string, unknown>[];
    },
    async updateReportStatus(reportId: string, status: ReportStatus): Promise<boolean> {
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        'UPDATE emergency_reports SET status = ? WHERE id = ?',
        [status, reportId]
      );
      return result.affectedRows > 0;
    },
    async createFacilitySuggestion(userId: number, input: NewFacilitySuggestion): Promise<string> {
      const id = crypto.randomUUID();
      await pool.execute(
        `INSERT INTO facility_suggestions
          (id, user_id, facility_name, facility_type, address, latitude, longitude, contact_number, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          userId,
          input.facilityName,
          input.facilityType,
          input.address ?? null,
          input.latitude,
          input.longitude,
          input.contactNumber ?? null,
          input.sourceUrl ?? null
        ]
      );
      return id;
    },
    async getFacilitySuggestionsForUser(userId: number): Promise<Record<string, unknown>[]> {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, user_id AS submittedBy, facility_name AS facilityName, facility_type AS facilityType,
         address, latitude, longitude, contact_number AS contactNumber, source_url AS sourceUrl,
         review_status AS reviewStatus, review_note AS reviewNote, created_at AS createdAt
         FROM facility_suggestions WHERE user_id = ? ORDER BY created_at DESC`,
        [userId]
      );
      return rows as Record<string, unknown>[];
    },
    async getAllFacilitySuggestions(): Promise<Record<string, unknown>[]> {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, user_id AS submittedBy, facility_name AS facilityName, facility_type AS facilityType,
         address, latitude, longitude, contact_number AS contactNumber, source_url AS sourceUrl,
         review_status AS reviewStatus, review_note AS reviewNote, created_at AS createdAt
         FROM facility_suggestions ORDER BY created_at DESC`
      );
      return rows as Record<string, unknown>[];
    },
    async reviewFacilitySuggestion(id: string, status: SuggestionStatus, note: string): Promise<boolean> {
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        `UPDATE facility_suggestions SET review_status = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, note || null, id]
      );
      return result.affectedRows > 0;
    }
  };

  return { accounts, privateRecords };
}

export class FirestoreAdminContentRepository implements AdminContentRepository {
  private readonly collections: Record<ContentCollection, string> = {
    emergencyCategories: 'emergencyCategories',
    emergencyHotlines: 'emergencyHotlines',
    emergencyGuides: 'emergencyGuides'
  };

  async getAll(collection: ContentCollection): Promise<Record<string, unknown>[]> {
    const database = await this.getFirestore();
    const snapshot = await database.collection(this.collections[collection]).get();
    return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
  }

  async save(
    collection: ContentCollection,
    value: Record<string, unknown>,
    id?: string
  ): Promise<string> {
    const database = await this.getFirestore();
    const records = database.collection(this.collections[collection]);
    const savedAt = new Date().toISOString();
    if (id) {
      await records.doc(id).set({ ...value, updatedAt: savedAt }, { merge: true });
      return id;
    }
    const reference = await records.add({ ...value, createdAt: savedAt, updatedAt: savedAt });
    return reference.id;
  }

  async delete(collection: ContentCollection, id: string): Promise<void> {
    const database = await this.getFirestore();
    await database.collection(this.collections[collection]).doc(id).delete();
  }

  private async getFirestore(): Promise<import('firebase-admin/firestore').Firestore> {
    const { applicationDefault, getApps, initializeApp } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const app = getApps()[0] ?? initializeApp({
      credential: applicationDefault(),
      ...(process.env.FIREBASE_PROJECT_ID ? { projectId: process.env.FIREBASE_PROJECT_ID } : {})
    });
    return getFirestore(app);
  }
}
