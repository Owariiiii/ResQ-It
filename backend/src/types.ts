export type UserRole = 'user' | 'admin';
export type ContentCollection = 'emergencyCategories' | 'emergencyHotlines' | 'emergencyGuides';
export type ReportStatus = 'Submitted' | 'Under Review' | 'Resolved' | 'Closed';
export type SuggestionStatus = 'approved' | 'rejected';

export interface UserRecord {
  id: number;
  fullName: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  phoneNumber: string | null;
  emergencyContactName: string | null;
  emergencyContactNumber: string | null;
  tokenVersion: number;
  isActive: boolean;
}

export interface PublicUser {
  id: number;
  fullName: string;
  email: string;
  role: UserRole;
  phoneNumber: string;
  emergencyContactName: string;
  emergencyContactNumber: string;
}

export interface NewUser {
  fullName: string;
  email: string;
  passwordHash: string;
  phoneNumber?: string;
  emergencyContactName?: string;
  emergencyContactNumber?: string;
}

export interface UserProfileUpdate {
  fullName: string;
  phoneNumber?: string;
  emergencyContactName?: string;
  emergencyContactNumber?: string;
}

export interface NewReport {
  category: 'medical' | 'fire' | 'police' | 'accident' | 'disaster' | 'other';
  description?: string;
  latitude?: number;
  longitude?: number;
}

export interface NewFacilitySuggestion {
  facilityName: string;
  facilityType: string;
  address?: string;
  latitude: number;
  longitude: number;
  contactNumber?: string;
  sourceUrl?: string;
}

export interface AccountRepository {
  createUser(input: NewUser): Promise<UserRecord>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: number): Promise<UserRecord | null>;
  updateProfile(id: number, input: UserProfileUpdate): Promise<UserRecord>;
  changePassword(id: number, passwordHash: string): Promise<void>;
}

export interface PrivateRecordRepository {
  createReport(userId: number, input: NewReport): Promise<string>;
  getReportsForUser(userId: number): Promise<Record<string, unknown>[]>;
  getAllReports(): Promise<Record<string, unknown>[]>;
  updateReportStatus(reportId: string, status: ReportStatus): Promise<boolean>;
  createFacilitySuggestion(userId: number, input: NewFacilitySuggestion): Promise<string>;
  getFacilitySuggestionsForUser(userId: number): Promise<Record<string, unknown>[]>;
  getAllFacilitySuggestions(): Promise<Record<string, unknown>[]>;
  reviewFacilitySuggestion(id: string, status: SuggestionStatus, note: string): Promise<boolean>;
}

export interface AdminContentRepository {
  getAll(collection: ContentCollection): Promise<Record<string, unknown>[]>;
  save(
    collection: ContentCollection,
    value: Record<string, unknown>,
    id?: string
  ): Promise<string>;
  delete(collection: ContentCollection, id: string): Promise<void>;
}
