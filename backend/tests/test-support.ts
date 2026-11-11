import request from 'supertest';
import { createApp } from '../src/app.js';
import type {
  AccountRepository, AdminContentRepository, ContentCollection, NewFacilitySuggestion,
  NewReport, NewUser, PrivateRecordRepository, PublicUser, UserProfileUpdate, UserRecord
} from '../src/types.js';

const SECRET = 'test-only-secret-that-is-long-enough-and-never-used-outside-this-test-suite';

class MemoryRepositories implements AccountRepository, PrivateRecordRepository, AdminContentRepository {
  private readonly users = new Map<number, UserRecord>();
  private readonly records = new Map<string, Record<string, unknown>[]>();
  private readonly reports: Array<Record<string, unknown>> = [];
  private readonly suggestions: Array<Record<string, unknown>> = [];
  private nextUserId = 1;

  async createUser(input: NewUser): Promise<UserRecord> {
    if ([...this.users.values()].some((user) => user.email === input.email)) {
      throw Object.assign(new Error('Duplicate email'), { code: 'ER_DUP_ENTRY' });
    }
    const user: UserRecord = {
      id: this.nextUserId++,
      fullName: input.fullName,
      email: input.email,
      passwordHash: input.passwordHash,
      role: 'user',
      phoneNumber: input.phoneNumber || null,
      emergencyContactName: input.emergencyContactName || null,
      emergencyContactNumber: input.emergencyContactNumber || null,
      tokenVersion: 0,
      isActive: true
    };
    this.users.set(user.id, user);
    return user;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return [...this.users.values()].find((user) => user.email === email) ?? null;
  }

  async findUserById(id: number): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async updateProfile(id: number, input: UserProfileUpdate): Promise<UserRecord> {
    const user = this.users.get(id);
    if (!user) throw new Error('User not found');
    const updated = {
      ...user,
      fullName: input.fullName,
      phoneNumber: input.phoneNumber || null,
      emergencyContactName: input.emergencyContactName || null,
      emergencyContactNumber: input.emergencyContactNumber || null
    };
    this.users.set(id, updated);
    return updated;
  }

  async changePassword(id: number, passwordHash: string): Promise<void> {
    const user = this.users.get(id);
    if (!user) throw new Error('User not found');
    this.users.set(id, { ...user, passwordHash, tokenVersion: user.tokenVersion + 1 });
  }

  promoteToAdmin(id: number): void {
    const user = this.users.get(id);
    if (!user) throw new Error('User not found');
    this.users.set(id, { ...user, role: 'admin' });
  }

  async createReport(userId: number, input: NewReport): Promise<string> {
    const reportId = crypto.randomUUID();
    this.reports.push({ reportId, userId, ...input, status: 'Submitted', createdAt: new Date().toISOString() });
    return reportId;
  }

  async getReportsForUser(userId: number): Promise<Record<string, unknown>[]> {
    return this.reports.filter((report) => report.userId === userId);
  }

  async getAllReports(): Promise<Record<string, unknown>[]> {
    return [...this.reports];
  }

  async updateReportStatus(reportId: string, status: 'Submitted' | 'Under Review' | 'Resolved' | 'Closed'): Promise<boolean> {
    const report = this.reports.find((item) => item.reportId === reportId);
    if (!report) return false;
    report.status = status;
    return true;
  }

  async createFacilitySuggestion(userId: number, input: NewFacilitySuggestion): Promise<string> {
    const id = crypto.randomUUID();
    this.suggestions.push({ id, submittedBy: userId, ...input, reviewStatus: 'pending' });
    return id;
  }

  async getFacilitySuggestionsForUser(userId: number): Promise<Record<string, unknown>[]> {
    return this.suggestions.filter((suggestion) => suggestion.submittedBy === userId);
  }

  async getAllFacilitySuggestions(): Promise<Record<string, unknown>[]> {
    return [...this.suggestions];
  }

  async reviewFacilitySuggestion(
    id: string,
    status: 'approved' | 'rejected',
    note: string
  ): Promise<boolean> {
    const suggestion = this.suggestions.find((item) => item.id === id);
    if (!suggestion) return false;
    suggestion.reviewStatus = status;
    suggestion.reviewNote = note;
    return true;
  }

  async getAll(collection: ContentCollection): Promise<Record<string, unknown>[]> {
    return [...(this.records.get(collection) ?? [])];
  }

  async save(
    collection: ContentCollection,
    value: Record<string, unknown>,
    id?: string
  ): Promise<string> {
    const values = this.records.get(collection) ?? [];
    const recordId = id ?? crypto.randomUUID();
    const item = { ...value, id: recordId };
    const position = values.findIndex((record) => record.id === recordId);
    if (position === -1) values.push(item);
    else values[position] = item;
    this.records.set(collection, values);
    return recordId;
  }

  async delete(collection: ContentCollection, id: string): Promise<void> {
    const records = this.records.get(collection) ?? [];
    this.records.set(collection, records.filter((record) => record.id !== id));
  }
}

export async function createTestApi(options: {
  verifyFirebaseIdToken?: (token: string) => Promise<{
    uid: string;
    admin: boolean;
    email?: string;
    name?: string;
  }>;
} = {}): Promise<{
  api: ReturnType<typeof request>;
  repositories: MemoryRepositories;
}> {
  const repositories = new MemoryRepositories();
  const app = createApp({
    accounts: repositories,
    privateRecords: repositories,
    content: repositories,
    jwtSecret: SECRET,
    jwtExpiresIn: '15m',
    corsOrigins: ['http://localhost:4200'],
    ...options
  });
  return { api: request(app), repositories };
}

export async function createAccount(
  api: ReturnType<typeof request>,
  email = `test-${crypto.randomUUID()}@example.com`
): Promise<{ token: string; user: PublicUser }> {
  const response = await api.post('/api/auth/register').send({
    fullName: 'Test User',
    email,
    password: 'SecurePass123!'
  });
  if (response.status !== 201) throw new Error(`Test registration failed: ${response.status}`);
  return response.body as { token: string; user: PublicUser };
}
