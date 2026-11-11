import { Injectable } from '@angular/core';
import { HttpBackend, HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { getApps, initializeApp, FirebaseApp, FirebaseOptions } from 'firebase/app';
import {
  Auth,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  getAuth,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  updateProfile,
  User
} from 'firebase/auth';
import {
  DocumentData, DocumentSnapshot, Firestore, QueryDocumentSnapshot, QuerySnapshot, Timestamp, addDoc, collection, deleteDoc, doc, getDoc, getDocs, getFirestore,
  documentId,   limit, orderBy, query, serverTimestamp, setDoc, startAfter, where, writeBatch
} from 'firebase/firestore';
import { environment } from '../../environments/environment';
import {
  EmergencyCategory, EmergencyCategoryRecord, EmergencyGuide, EmergencyReport, Facility,
  FacilitySuggestion, Hotline
} from '../models/emergency.models';
import { facilityDuplicateKey, parseFacilityCsv } from '../utils/facility-csv';

export interface FacilityImportItem {
  line: number;
  facility: Omit<Facility, 'id' | 'distanceKm'>;
}

export interface FacilityImportResult {
  imported: number;
  updated: number;
  skipped: number;
  importedLines: number[];
  updatedLines: number[];
  skippedLines: number[];
  failed: Array<{ line: number; error: string }>;
}

export interface AdminHotlinePage {
  records: Hotline[];
  hasMore: boolean;
}

export interface FacilityMigrationResult {
  total: number;
  migrated: number;
  skipped: number;
  skippedRecords: Array<{ facilityId: string; reason: string }>;
  failed: Array<{ facilityId: string; error: string }>;
}

export interface FacilityMigrationProgress {
  total: number;
  processed: number;
  migrated: number;
  skipped: number;
  failed: number;
}

export const RESQ_IT_ADMIN_UID = '279f5QypzDUvSe7diQl1AqlbUYK2';

export interface FirebaseUserProfile {
  uid: string;
  fullName: string;
  email: string;
  role: 'user' | 'admin';
  phoneNumber?: string;
  emergencyContactName?: string;
  emergencyContactNumber?: string;
  accountCreatedAt?: Date | null;
  accountUpdatedAt?: Date | null;
}

@Injectable({ providedIn: 'root' })
export class FirebaseService {
  readonly app: FirebaseApp | null;
  readonly auth: Auth | null;
  readonly db: Firestore | null;
  currentUser: User | null = null;
  isAdmin = false;
  authReady = false;
  private showingLegacyDirectoryData = false;
  private resolveInitialAuthState!: () => void;
  private readonly authStateSubscribers = new Set<(user: User | null) => void>();
  private readonly initialAuthState = new Promise<void>((resolve) => {
    this.resolveInitialAuthState = resolve;
  });
  private authStateVersion = 0;
  private adminHotlineCursor: QueryDocumentSnapshot<DocumentData> | null = null;
  private readonly adminHotlinePageSize = 100;
  private publicHotlinesCache: { expiresAt: number; records: Hotline[] } | null = null;
  private publicHotlinesRequest: Promise<Hotline[]> | null = null;
  private readonly assetHttp: HttpClient;
  private readonly developmentCsvSeed: Promise<Hotline[]>;
  private readonly publicDirectoryFallback: Promise<Hotline[]>;
  private readonly filteredHotlineCache = new Map<string, { expiresAt: number; records: Hotline[] }>();

  constructor(httpBackend: HttpBackend) {
    this.assetHttp = new HttpClient(httpBackend);
    const config = environment.firebase as FirebaseOptions;
    const existingApp = getApps().find((app) => app.name === '[DEFAULT]');
    if (existingApp && (
      existingApp.options.projectId !== config.projectId
      || existingApp.options.apiKey !== config.apiKey
      || existingApp.options.authDomain !== config.authDomain
    )) {
      throw new Error('A Firebase app is already initialized with a different project configuration.');
    }
    this.app = config.apiKey && config.projectId && config.appId
      ? existingApp ?? initializeApp(config)
      : null;
    this.auth = this.app ? getAuth(this.app) : null;
    this.db = this.app ? getFirestore(this.app) : null;
    if (this.auth) {
      onAuthStateChanged(this.auth, async (user) => {
        const stateVersion = ++this.authStateVersion;
        this.invalidatePublicHotlinesCache();
        this.currentUser = user;
        this.isAdmin = false;
        if (user) {
          try {
            await this.refreshAdminClaim();
          } catch (error) {
            console.error('Could not verify the Firebase administrator claim.', error);
          }
        }
        if (stateVersion !== this.authStateVersion) return;
        this.authReady = true;
        this.resolveInitialAuthState();
        for (const subscriber of this.authStateSubscribers) subscriber(user);
      }, (error) => {
        this.authReady = true;
        this.resolveInitialAuthState();
        console.error('Could not restore Firebase Authentication state.', error);
      });
    } else {
      this.authReady = true;
      this.resolveInitialAuthState();
    }
    this.developmentCsvSeed = environment.directoryTestingMode && !environment.production
      ? this.loadDevelopmentCsvSeed()
      : Promise.resolve([]);
    this.publicDirectoryFallback = environment.production
      ? this.loadPublicDirectoryFallback()
      : Promise.resolve([]);
  }

  async waitForInitialAuthState(): Promise<void> {
    await this.initialAuthState;
  }

  subscribeAuthState(subscriber: (user: User | null) => void): () => void {
    this.authStateSubscribers.add(subscriber);
    if (this.authReady) subscriber(this.currentUser);
    return () => this.authStateSubscribers.delete(subscriber);
  }

  get isConfigured(): boolean {
    return this.auth !== null && this.db !== null;
  }

  get isShowingLegacyDirectoryData(): boolean {
    return this.showingLegacyDirectoryData;
  }

  async register(fullName: string, email: string, password: string, profile: {
    phoneNumber?: string;
    emergencyContactName?: string;
    emergencyContactNumber?: string;
  } = {}): Promise<User> {
    const auth = this.requireAuth();
    try {
      const credentials = await createUserWithEmailAndPassword(auth, email.trim(), password);
      this.currentUser = credentials.user;
      this.isAdmin = false;
      await updateProfile(credentials.user, { displayName: fullName.trim() });
      await this.saveUserProfile(credentials.user.uid, {
        fullName: fullName.trim(),
        email: credentials.user.email ?? email,
        phoneNumber: profile.phoneNumber?.trim() ?? '',
        emergencyContactName: profile.emergencyContactName?.trim() ?? '',
        emergencyContactNumber: profile.emergencyContactNumber?.trim() ?? ''
      });
      this.authReady = true;
      return credentials.user;
    } catch (error) {
      throw this.authError(error);
    }
  }

  async login(email: string, password: string): Promise<User> {
    let user: User;
    try {
      const result = await signInWithEmailAndPassword(this.requireAuth(), email.trim(), password);
      user = result.user;
    } catch (error) {
      console.error('[Firebase Auth] Email/password sign-in failed.', {
        projectId: environment.firebase.projectId,
        errorCode: this.errorCode(error),
        errorMessage: this.errorMessage(error)
      });
      throw this.authError(error);
    }
    this.currentUser = user;
    this.authReady = true;
    try {
      await this.refreshAdminClaim();
    } catch (error) {
      this.isAdmin = false;
      console.warn('Sign-in succeeded, but Firebase administrator claims could not be verified.', {
        uid: user.uid,
        errorCode: this.errorCode(error),
        errorMessage: this.errorMessage(error)
      });
    }
    return user;
  }

  async resetPassword(email: string): Promise<void> {
    try {
      await sendPasswordResetEmail(this.requireAuth(), email);
    } catch (error) {
      throw this.authError(error);
    }
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const user = this.currentUser;
    if (!user || !user.email) throw new Error('Sign in to update your password.');
    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, newPassword);
  }

  async logout(): Promise<void> {
    await signOut(this.requireAuth());
    this.currentUser = null;
    this.isAdmin = false;
  }

  async updateDisplayName(fullName: string): Promise<void> {
    const user = this.currentUser;
    if (!user) throw new Error('Sign in to update your display name.');
    const trimmed = fullName.trim();
    await updateProfile(user, { displayName: trimmed });
    await this.saveUserProfile(user.uid, { fullName: trimmed });
  }

  async updateProfile(profile: {
    fullName: string;
    phoneNumber?: string;
    emergencyContactName?: string;
    emergencyContactNumber?: string;
  }): Promise<FirebaseUserProfile> {
    const user = this.currentUser;
    if (!user) throw new Error('Sign in to update your profile.');
    const payload = {
      fullName: profile.fullName.trim(),
      phoneNumber: profile.phoneNumber?.trim() ?? '',
      emergencyContactName: profile.emergencyContactName?.trim() ?? '',
      emergencyContactNumber: profile.emergencyContactNumber?.trim() ?? ''
    };
    await Promise.all([
      updateProfile(user, { displayName: payload.fullName }),
      this.saveUserProfile(user.uid, payload)
    ]);
    return await this.getCurrentUserProfile() ?? {
      uid: user.uid,
      fullName: payload.fullName,
      email: user.email ?? '',
      role: this.isAdmin && user.uid === RESQ_IT_ADMIN_UID ? 'admin' : 'user',
      phoneNumber: payload.phoneNumber,
      emergencyContactName: payload.emergencyContactName,
      emergencyContactNumber: payload.emergencyContactNumber
    };
  }

  async getCurrentUserProfile(): Promise<FirebaseUserProfile | null> {
    const user = this.currentUser ?? this.auth?.currentUser ?? null;
    if (!user || !this.db) return null;
    const snapshot = await this.readDocument(
      'users',
      user.uid,
      getDoc(doc(this.db, 'users', user.uid))
    );
    if (!snapshot.exists()) {
      await this.saveUserProfile(user.uid, {
        fullName: user.displayName ?? '',
        email: user.email ?? ''
      });
      return this.getCurrentUserProfile();
    }
    const data = snapshot.data() as Partial<FirebaseUserProfile> & { email?: string };
    if (!data.role || (this.isAdmin && data.role !== 'admin')) {
      await this.saveUserProfile(user.uid, {
        fullName: data.fullName ?? user.displayName ?? '',
        email: data.email ?? user.email ?? '',
        phoneNumber: data.phoneNumber ?? '',
        emergencyContactName: data.emergencyContactName ?? '',
        emergencyContactNumber: data.emergencyContactNumber ?? ''
      });
      return this.getCurrentUserProfile();
    }
    return {
      uid: user.uid,
      fullName: data.fullName ?? user.displayName ?? '',
      email: data.email ?? user.email ?? '',
      role: data.role === 'admin' && this.isAdmin ? 'admin' : 'user',
      phoneNumber: data.phoneNumber ?? '',
      emergencyContactName: data.emergencyContactName ?? '',
      emergencyContactNumber: data.emergencyContactNumber ?? '',
      accountCreatedAt: this.timestampToDate(data.accountCreatedAt),
      accountUpdatedAt: this.timestampToDate(data.accountUpdatedAt)
    };
  }

  async refreshAdminClaim(forceRefresh = false): Promise<boolean> {
    const user = this.currentUser;
    if (!user) {
      this.isAdmin = false;
      return false;
    }
    const token = await user.getIdTokenResult(forceRefresh);
    this.isAdmin = this.currentUser?.uid === user.uid
      && user.uid === RESQ_IT_ADMIN_UID
      && token.claims['admin'] === true;
    return this.isAdmin;
  }

  async getAdminDashboard(): Promise<{
    categories: EmergencyCategoryRecord[];
    hotlines: Hotline[];
    guides: EmergencyGuide[];
    hasMoreHotlines: boolean;
  }> {
    this.requireAdmin();
    const db = this.requireDb();
    const [categories, hotlinePage, guides] = await Promise.all([
      this.readCollection('emergencyCategories', 'all documents (administrator)', getDocs(collection(db, 'emergencyCategories'))),
      this.getAdminHotlines(true),
      this.readCollection('emergencyGuides', 'all documents (administrator)', getDocs(collection(db, 'emergencyGuides')))
    ]);
    return {
      categories: categories.docs.map((entry) => ({ id: entry.id, ...entry.data() } as EmergencyCategoryRecord)),
      hotlines: hotlinePage.records,
      hasMoreHotlines: hotlinePage.hasMore,
      guides: guides.docs.map((entry) => ({ id: entry.id, ...entry.data() } as EmergencyGuide))
    };
  }

  async getAdminHotlines(reset = false): Promise<AdminHotlinePage> {
    this.requireAdmin();
    if (reset) this.adminHotlineCursor = null;
    const constraints = [
      orderBy(documentId()),
      limit(this.adminHotlinePageSize),
      ...(this.adminHotlineCursor ? [startAfter(this.adminHotlineCursor)] : [])
    ];
    const snapshot = await this.readCollection(
      'emergencyHotlines',
      'administrator hotline page',
      getDocs(query(collection(this.requireDb(), 'emergencyHotlines'), ...constraints))
    );
    this.adminHotlineCursor = snapshot.docs.at(-1) ?? null;
    return {
      records: snapshot.docs.map((entry) => this.toHotline(entry.id, entry.data(), 'emergencyHotlines')),
      hasMore: snapshot.size === this.adminHotlinePageSize
    };
  }

  async getAdminFacilities(): Promise<Facility[]> {
    this.requireAdmin();
    const snapshot = await this.readCollection(
      'emergencyHotlines',
      'all hotline and facility records (administrator directory)',
      getDocs(collection(this.requireDb(), 'emergencyHotlines'))
    );
    return snapshot.docs.map((entry) =>
      this.toFacility(entry.id, entry.data(), 'emergencyHotlines')
    );
  }

  async getAdminLegacyFacilities(): Promise<Facility[]> {
    this.requireAdmin();
    const snapshot = await this.readCollection(
      'emergencyFacilities',
      'all documents (administrator migration preview)',
      getDocs(collection(this.requireDb(), 'emergencyFacilities'))
    );
    return snapshot.docs.map((entry) =>
      this.toFacility(entry.id, entry.data(), 'emergencyFacilities')
    );
  }

  async saveFacility(
    facility: Omit<Facility, 'id' | 'distanceKm'>,
    id?: string
  ): Promise<void> {
    this.requireAdmin();
    const db = this.requireDb();
    const data = this.toFacilityImportData(facility);
    data['verificationStatus'] = facility.verificationStatus ?? 'unverified';
    data['isActive'] = facility.isActive === true;
    data['phoneVerified'] = facility.phoneVerified === true;
    data['locationVerified'] = facility.locationVerified === true;
    data['isCallable'] = facility.isCallable === true;
    data['emailVerified'] = facility.emailVerified === true;
    data['facebookVerified'] = facility.facebookVerified === true;
    data['websiteVerified'] = facility.websiteVerified === true;
    if (facility.verificationStatus === 'verified') data['lastVerifiedAt'] = serverTimestamp();
    data['updatedAt'] = serverTimestamp();
    if (id) {
      await setDoc(doc(db, 'emergencyHotlines', id), data, { merge: true });
    } else {
      await addDoc(collection(db, 'emergencyHotlines'), {
        ...data,
        createdAt: serverTimestamp()
      });
    }
    this.invalidatePublicHotlinesCache();
  }

  async importFacilities(
    facilities: FacilityImportItem[],
    updateUnverifiedDuplicates = false,
    onProgress?: (percentage: number) => void
  ): Promise<FacilityImportResult> {
    return this.importHotlines(facilities, updateUnverifiedDuplicates, onProgress);
  }

  async importHotlines(
    facilities: FacilityImportItem[],
    updateUnverifiedDuplicates = false,
    onProgress?: (percentage: number) => void
  ): Promise<FacilityImportResult> {
    const result = await this.importDirectoryRecords(
      'emergencyHotlines',
      facilities,
      (facility) => this.toHotlineImportData(facility),
      updateUnverifiedDuplicates,
      onProgress
    );
    this.invalidatePublicHotlinesCache();
    return result;
  }

  private async importDirectoryRecords(
    targetCollection: 'emergencyHotlines',
    facilities: FacilityImportItem[],
    toDocument: (facility: Omit<Facility, 'id' | 'distanceKm'>) => Record<string, unknown>,
    updateUnverifiedDuplicates: boolean,
    onProgress?: (percentage: number) => void
  ): Promise<FacilityImportResult> {
    this.requireAdmin();
    const db = this.requireDb();
    const existingSnapshot = await this.readCollection(
      targetCollection,
      'all documents (administrator import duplicate check)',
      getDocs(collection(db, targetCollection))
    );
    const existingIds = new Set(existingSnapshot.docs.map((entry) => entry.id));
    const existingByKey = new Map<string, (typeof existingSnapshot.docs)[number]>();
    for (const entry of existingSnapshot.docs) {
      const data = entry.data();
      const key = facilityDuplicateKey(
        String(data['name'] ?? ''),
        String(data['category'] ?? data['type'] ?? ''),
        String(data['municipality'] ?? data['region'] ?? '')
      );
      const previous = existingByKey.get(key);
      if (!previous
        || data['verificationStatus'] === 'verified'
        || data['status'] === 'verified') {
        existingByKey.set(key, entry);
      }
    }
    const jobs: Array<{
      line: number;
      id: string;
      data: Record<string, unknown>;
      update: boolean;
    }> = [];
    const failed: FacilityImportResult['failed'] = [];
    const skippedLines: number[] = [];
    let skipped = 0;
    const plannedKeys = new Set<string>();

    for (const { line, facility } of facilities) {
      const key = facilityDuplicateKey(
        facility.name,
        String(facility.category ?? facility.type),
        facility.municipality ?? ''
      );
      if (plannedKeys.has(key)) {
        skipped += 1;
        skippedLines.push(line);
        continue;
      }
      plannedKeys.add(key);

      const existing = existingByKey.get(key);
      const existingData = existing?.data() ?? {};
      if (existing && (existingData['verificationStatus'] === 'verified' || existingData['status'] === 'verified')) {
        skipped += 1;
        skippedLines.push(line);
        continue;
      }
      if (existing && !updateUnverifiedDuplicates) {
        skipped += 1;
        skippedLines.push(line);
        continue;
      }

      let id = existing?.id ?? `import-${this.stableHash(key)}`;
      if (!existingIds.has(id)) existingIds.add(id);
      else if (!existing) {
        id = `import-${this.stableHash(`${key}|${line}`)}`;
        if (existingIds.has(id)) {
          failed.push({ line, error: 'Could not generate a unique document ID for this facility.' });
          continue;
        }
        existingIds.add(id);
      }

      const data = toDocument(facility);
      if (!existing) data['createdAt'] = serverTimestamp();
      data['updatedAt'] = serverTimestamp();
      jobs.push({ line, id, data, update: Boolean(existing) });
    }

    const importedLines: number[] = [];
    const updatedLines: number[] = [];
    let completed = 0;
    for (let offset = 0; offset < jobs.length; offset += 450) {
      const chunk = jobs.slice(offset, offset + 450);
      const batch = writeBatch(db);
      for (const job of chunk) {
        batch.set(doc(db, targetCollection, job.id), job.data, { merge: job.update });
      }
      try {
        await batch.commit();
        importedLines.push(...chunk.filter((job) => !job.update).map((job) => job.line));
        updatedLines.push(...chunk.filter((job) => job.update).map((job) => job.line));
      } catch (error) {
        const message = this.errorMessage(error);
        console.error('[Firestore] Facility CSV import batch failed.', { rows: chunk.map((job) => job.line), error });
        failed.push(...chunk.map((job) => ({ line: job.line, error: message })));
      } finally {
        completed += chunk.length;
        onProgress?.(Math.round(completed / jobs.length * 100));
      }
    }

    return {
      imported: importedLines.length,
      updated: updatedLines.length,
      skipped,
      importedLines,
      updatedLines,
      skippedLines,
      failed
    };
  }

  private toFacilityImportData(facility: Omit<Facility, 'id' | 'distanceKm'>): Record<string, unknown> {
    const data: Record<string, unknown> = {
      name: facility.name.trim(),
      type: facility.type.trim() || facility.category || 'other',
      category: facility.category ?? 'other',
      municipality: facility.municipality?.trim() ?? '',
      region: facility.region?.trim() ?? 'Oriental Mindoro',
      countryCode: facility.countryCode?.trim() ?? 'PH',
      phone: facility.phone?.trim() ?? '',
      phoneNumber: facility.phone?.trim() ?? '',
      description: facility.description?.trim() ?? '',
      officialSourceUrl: facility.officialSourceUrl?.trim() ?? facility.sourceUrl?.trim() ?? '',
      sourceUrl: facility.sourceUrl?.trim() ?? facility.officialSourceUrl?.trim() ?? '',
      verificationStatus: 'unverified',
      isActive: false,
      isPublic: facility.isPublic === true,
      phoneVerified: false,
      locationVerified: false,
      isCallable: false,
      emailVerified: false,
      facebookVerified: false,
      websiteVerified: false,
      address: facility.address?.trim() ?? '',
      barangay: facility.barangay?.trim() ?? '',
      email: facility.email?.trim() ?? '',
      facebook: facility.facebook?.trim() ?? facility.facebookUrl?.trim() ?? '',
      facebookUrl: facility.facebookUrl?.trim() ?? facility.facebook?.trim() ?? '',
      website: facility.website?.trim() ?? facility.websiteUrl?.trim() ?? '',
      websiteUrl: facility.websiteUrl?.trim() ?? facility.website?.trim() ?? '',
      openingHours: facility.openingHours?.trim() ?? '',
      alternativePhone: (facility.alternativePhone ?? []).filter((phone) => phone.trim())
    };
    if (typeof facility.latitude === 'number' && Number.isFinite(facility.latitude)
      && facility.latitude >= -90 && facility.latitude <= 90) data['latitude'] = facility.latitude;
    if (typeof facility.longitude === 'number' && Number.isFinite(facility.longitude)
      && facility.longitude >= -180 && facility.longitude <= 180) data['longitude'] = facility.longitude;
    return data;
  }

  private toHotlineImportData(facility: Omit<Facility, 'id' | 'distanceKm'>): Record<string, unknown> {
    const data: Record<string, unknown> = {
      name: facility.name.trim(),
      type: facility.type.trim(),
      category: facility.category ?? 'other',
      municipality: facility.municipality?.trim() ?? '',
      region: facility.region?.trim() ?? facility.municipality?.trim() ?? 'Oriental Mindoro',
      countryCode: facility.countryCode?.trim() ?? 'PH',
      phoneNumber: facility.phone?.trim() ?? '',
      description: facility.description?.trim() ?? '',
      officialSourceUrl: facility.sourceUrl?.trim() ?? facility.officialSourceUrl?.trim() ?? '',
      sourceUrl: facility.sourceUrl?.trim() ?? facility.officialSourceUrl?.trim() ?? '',
      verificationStatus: 'unverified',
      isActive: false,
      isPublic: facility.isPublic === true,
      phoneVerified: false,
      locationVerified: false,
      isCallable: false
    };
    const optionalFields: Array<[keyof Omit<Facility, 'id' | 'distanceKm'>, string]> = [
      ['address', 'address'],
      ['barangay', 'barangay'],
      ['email', 'email'],
      ['facebook', 'facebook'],
      ['website', 'website'],
      ['openingHours', 'openingHours']
    ];
    for (const [source, target] of optionalFields) {
      const value = facility[source];
      if (typeof value === 'string' && value.trim()) data[target] = value.trim();
    }
    if (facility.alternativePhone?.length) {
      data['alternativePhone'] = facility.alternativePhone.filter((phone) => phone.trim());
    }
    if (facility.facebook?.trim()) data['facebookUrl'] = facility.facebook.trim();
    if (facility.website?.trim()) data['websiteUrl'] = facility.website.trim();
    if (typeof facility.latitude === 'number' && Number.isFinite(facility.latitude)
      && facility.latitude >= -90 && facility.latitude <= 90) data['latitude'] = facility.latitude;
    if (typeof facility.longitude === 'number' && Number.isFinite(facility.longitude)
      && facility.longitude >= -180 && facility.longitude <= 180) data['longitude'] = facility.longitude;
    return data;
  }

  async migrateFacilitiesToHotlines(
    onProgress?: (progress: FacilityMigrationProgress) => void,
    sourceFacilityIds?: readonly string[]
  ): Promise<FacilityMigrationResult> {
    await this.refreshAdminClaim();
    this.requireAdmin();
    const db = this.requireDb();
    const [facilitiesSnapshot, hotlinesSnapshot] = await Promise.all([
      this.readCollection(
        'emergencyFacilities',
        'all documents (administrator one-time migration source)',
        getDocs(collection(db, 'emergencyFacilities'))
      ),
      this.readCollection(
        'emergencyHotlines',
        'all documents (administrator migration duplicate check)',
        getDocs(collection(db, 'emergencyHotlines'))
      )
    ]);

    const destinationKeys = new Set(hotlinesSnapshot.docs.map((entry) => {
      const data = entry.data();
      const hotline = this.toHotline(entry.id, data, 'emergencyHotlines');
      return facilityDuplicateKey(
        hotline.name,
        hotline.category,
        hotline.municipality?.trim() || hotline.region
      );
    }));
    const migratedSourceIds = new Set(hotlinesSnapshot.docs
      .map((entry) => entry.data()['legacyFacilityId'])
      .filter((id): id is string => typeof id === 'string'));
    const requestedIds = sourceFacilityIds ? new Set(sourceFacilityIds) : null;
    if (requestedIds?.has('')) throw new Error('A source facility ID is required for a targeted migration.');
    const sourceDocuments = requestedIds
      ? facilitiesSnapshot.docs.filter((entry) => requestedIds.has(entry.id))
      : facilitiesSnapshot.docs;
    if (requestedIds && sourceDocuments.length !== requestedIds.size) {
      const missing = [...requestedIds].filter((id) =>
        !facilitiesSnapshot.docs.some((entry) => entry.id === id)
      );
      throw new Error(`The legacy facility record was not found: ${missing.join(', ')}.`);
    }
    const total = sourceDocuments.length;
    const result: FacilityMigrationResult = {
      total,
      migrated: 0,
      skipped: 0,
      skippedRecords: [],
      failed: []
    };
    const progress: FacilityMigrationProgress = {
      total,
      processed: 0,
      migrated: 0,
      skipped: 0,
      failed: 0
    };
    onProgress?.({ ...progress });

    const jobs: Array<{ facilityId: string; key: string; data: Record<string, unknown> }> = [];
    for (const entry of sourceDocuments) {
      const raw = entry.data();
      const facility = this.toFacility(entry.id, raw, 'emergencyFacilities');
      const sourceName = this.firstNonEmptyString(raw['name'], raw['facilityName']);
      if (!sourceName) {
        result.skippedRecords.push({ facilityId: entry.id, reason: 'Missing facility name.' });
        result.skipped += 1;
        progress.processed += 1;
        progress.skipped = result.skipped;
        onProgress?.({ ...progress });
        continue;
      }
      const sourceCategory = this.firstNonEmptyString(raw['category'], raw['type'], raw['facilityType']);
      const category = this.toEmergencyCategory(sourceCategory) ?? facility.category ?? 'other';
      const municipality = this.firstNonEmptyString(raw['municipality'], raw['city'], facility.municipality) ?? '';
      const duplicateLocation = municipality
        || this.firstNonEmptyString(raw['region'], raw['province'])
        || '';
      const key = facilityDuplicateKey(sourceName, category, duplicateLocation);
      if (migratedSourceIds.has(entry.id)) {
        result.skippedRecords.push({ facilityId: entry.id, reason: 'This source document was already migrated (legacyFacilityId match).' });
        result.skipped += 1;
        progress.processed += 1;
        progress.skipped = result.skipped;
        onProgress?.({ ...progress });
        continue;
      }
      if (destinationKeys.has(key)) {
        result.skippedRecords.push({ facilityId: entry.id, reason: 'A matching destination record already exists; it was not overwritten.' });
        result.skipped += 1;
        progress.processed += 1;
        progress.skipped = result.skipped;
        onProgress?.({ ...progress });
        continue;
      }

      const validCoordinates = this.toCoordinate(raw['latitude'] ?? raw['lat']) !== undefined
        && this.toCoordinate(raw['longitude'] ?? raw['lng']) !== undefined;
      const phoneNumber = this.firstNonEmptyString(
        raw['phoneNumber'], raw['phone'], raw['contactNumber'], raw['primaryPhone']
      ) ?? '';
      const verificationStatus = raw['verificationStatus'] === 'verified' || raw['status'] === 'verified'
        ? 'verified'
        : 'unverified';
      const sourceUrl = this.firstNonEmptyString(raw['officialSourceUrl'], raw['sourceUrl'], raw['source']) ?? '';
      const officialSourceUrl = sourceUrl.startsWith('https://') ? sourceUrl : '';
      const websiteValue = this.firstNonEmptyString(raw['website'], raw['websiteUrl']) ?? '';
      const facebookValue = this.firstNonEmptyString(raw['facebook'], raw['facebookUrl']) ?? '';
      const alternativePhone = Array.isArray(raw['alternativePhone'])
        ? raw['alternativePhone'].filter((value): value is string => typeof value === 'string').slice(0, 5)
        : typeof raw['alternativePhone'] === 'string' ? [raw['alternativePhone']] : [];
      const bounded = (value: unknown, maximum: number): string =>
        typeof value === 'string' ? value.trim().slice(0, maximum) : '';
      const data: Record<string, unknown> = {
        name: sourceName.slice(0, 160),
        type: bounded(this.firstNonEmptyString(raw['type'], raw['facilityType'], facility.type, category), 80),
        category,
        municipality: municipality.slice(0, 100),
        region: bounded(this.firstNonEmptyString(raw['region'], raw['province']), 120),
        countryCode: bounded(raw['countryCode'] ?? '', 8),
        address: bounded(raw['address'] ?? '', 300),
        latitude: this.toCoordinate(raw['latitude'] ?? raw['lat']),
        longitude: this.toCoordinate(raw['longitude'] ?? raw['lng']),
        phoneNumber: phoneNumber.slice(0, 40),
        alternativePhone: alternativePhone.map((value) => value.slice(0, 40)),
        email: bounded(this.firstNonEmptyString(raw['email']), 254),
        website: websiteValue.startsWith('https://') ? websiteValue.slice(0, 500) : '',
        facebook: facebookValue.startsWith('https://') ? facebookValue.slice(0, 500) : '',
        openingHours: bounded(this.firstNonEmptyString(raw['openingHours'], raw['operatingHours']), 160),
        description: bounded(this.firstNonEmptyString(raw['description']), 500),
        officialSourceUrl,
        ...(sourceUrl && !officialSourceUrl ? { legacySourceUrl: sourceUrl.slice(0, 500) } : {}),
        ...(websiteValue && !websiteValue.startsWith('https://') ? { legacyWebsite: websiteValue.slice(0, 500) } : {}),
        ...(facebookValue && !facebookValue.startsWith('https://') ? { legacyFacebook: facebookValue.slice(0, 500) } : {}),
        verificationStatus,
        isActive: raw['isActive'] === true || raw['active'] === true,
        phoneVerified: raw['phoneVerified'] === true && Boolean(this.normalizePhoneNumber(phoneNumber)),
        locationVerified: raw['locationVerified'] === true && validCoordinates,
        isCallable: (raw['isCallable'] === true || raw['callable'] === true)
          && (raw['isActive'] === true || raw['active'] === true)
          && verificationStatus === 'verified'
          && raw['phoneVerified'] === true
          && Boolean(this.normalizePhoneNumber(phoneNumber)),
        legacyFacilityId: entry.id,
        legacyData: raw,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        ...(verificationStatus === 'verified' ? { lastVerifiedAt: serverTimestamp() } : {})
      };
      for (const field of ['latitude', 'longitude']) {
        if (data[field] === undefined) delete data[field];
      }
      jobs.push({
        facilityId: entry.id,
        key,
        data
      });
      migratedSourceIds.add(entry.id);
      destinationKeys.add(key);
    }

    for (let offset = 0; offset < jobs.length; offset += 400) {
      const chunk = jobs.slice(offset, offset + 400);
      const batch = writeBatch(db);
      for (const job of chunk) {
        const targetId = `legacy-facility-${this.stableHash(job.facilityId)}`;
        batch.set(doc(db, 'emergencyHotlines', targetId), job.data, { merge: false });
      }
      try {
        await batch.commit();
        result.migrated += chunk.length;
      } catch (error) {
        const message = this.errorMessage(error);
        console.error('[Firestore] Facility migration batch failed.', {
          collection: 'emergencyFacilities',
          destination: 'emergencyHotlines',
          facilityIds: chunk.map((job) => job.facilityId),
          error
        });
        result.failed.push(...chunk.map((job) => ({ facilityId: job.facilityId, error: message })));
      } finally {
        progress.processed += chunk.length;
        progress.migrated = result.migrated;
        progress.skipped = result.skipped;
        progress.failed = result.failed.length;
        onProgress?.({ ...progress });
      }
    }
    this.invalidatePublicHotlinesCache();
    return result;
  }

  private normalizePhoneNumber(phone: string): string | null {
    const normalized = phone.trim().replace(/[\s().-]/g, '');
    return /^\+?\d{3,15}$/.test(normalized) ? normalized : null;
  }

  private stableHash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  async deleteFacility(id: string): Promise<void> {
    this.requireAdmin();
    await deleteDoc(doc(this.requireDb(), 'emergencyHotlines', id));
    this.invalidatePublicHotlinesCache();
  }

  async getVerifiedFacilities(municipality?: string, category?: EmergencyCategory): Promise<Facility[]> {
    const records = (await this.getVerifiedHotlines()).map((hotline) => this.hotlineToFacility(hotline));
    const allowTestingRecords = environment.directoryTestingMode && !environment.production
      && (this.isAdmin || this.showingLegacyDirectoryData);
    const normalize = (value: string) => this.normalizeMunicipality(value);
    return records.filter((facility) =>
      facility.name.length > 0
      && (allowTestingRecords
        || facility.isActive === true
        || facility.isPublic === true)
      && (!municipality || normalize(facility.municipality ?? '') === normalize(municipality))
      && (!category || facility.category === category || (category === 'accident' && ['medical', 'fire', 'police', 'other'].includes(facility.category ?? 'other')))
    );
  }

  async getPublicFacilities(municipality?: string, category?: EmergencyCategory): Promise<Facility[]> {
    return this.getVerifiedFacilities(municipality, category);
  }

  private toFacility(id: string, data: Record<string, unknown>, collectionName = 'unknown'): Facility {
    const location = typeof data['location'] === 'object' && data['location'] !== null
      ? data['location'] as { latitude?: unknown; longitude?: unknown; lat?: unknown; lng?: unknown }
      : null;
    const coordinates = typeof data['coordinates'] === 'object' && data['coordinates'] !== null
      ? data['coordinates'] as { latitude?: unknown; longitude?: unknown; lat?: unknown; lng?: unknown }
      : null;
    const latitude = this.toCoordinate(
      data['latitude'] ?? data['lat'] ?? location?.latitude ?? location?.lat
      ?? coordinates?.latitude ?? coordinates?.lat
    );
    const longitude = this.toCoordinate(
      data['longitude'] ?? data['lng'] ?? location?.longitude ?? location?.lng
      ?? coordinates?.longitude ?? coordinates?.lng
    );
    const phone = this.firstNonEmptyString(
      data['phone'], data['phoneNumber'], data['contactNumber'], data['primaryPhone']
    );
    const rawVerificationStatus = data['verificationStatus'] ?? data['status'];
    const verificationStatus = rawVerificationStatus === 'verified' ? 'verified' : 'unverified';
    const category = this.toEmergencyCategory(
      this.firstNonEmptyString(data['category'], data['type'], data['facilityType'])
    );
    const facilityType = this.firstNonEmptyString(data['type'], data['facilityType'], data['category']) ?? 'other';
    const municipality = this.firstNonEmptyString(data['municipality'], data['city']);
    const region = this.firstNonEmptyString(data['region'], data['province']);
    const rawName = this.firstNonEmptyString(data['name'], data['facilityName']);
    const hasName = Boolean(rawName);
    const name = rawName ?? 'Unnamed emergency record';
    if (!hasName) {
      console.warn('[Firestore] Facility document is missing a valid name.', {
        collection: collectionName,
        documentId: id,
        projectId: environment.firebase.projectId
      });
    }
    if ((data['latitude'] !== undefined || data['longitude'] !== undefined)
      && (latitude === undefined || longitude === undefined)) {
      console.warn('[Firestore] Facility document contains invalid coordinates.', {
        collection: collectionName,
        documentId: id,
        latitude: data['latitude'],
        longitude: data['longitude']
      });
    }

    return {
      id,
      name,
      type: facilityType,
      ...(category ? { category } : {}),
      ...(latitude !== undefined ? { latitude } : {}),
      ...(longitude !== undefined ? { longitude } : {}),
      ...(typeof data['address'] === 'string' ? { address: data['address'] } : {}),
      ...(typeof data['barangay'] === 'string' ? { barangay: data['barangay'] } : {}),
      ...(municipality ? { municipality } : {}),
      ...(typeof data['countryCode'] === 'string' ? { countryCode: data['countryCode'] } : {}),
      ...(region ? { region } : {}),
      ...(typeof phone === 'string' ? { phone } : {}),
      ...(Array.isArray(data['alternativePhone'])
        ? { alternativePhone: data['alternativePhone'].filter((item): item is string => typeof item === 'string') }
        : typeof data['alternativePhone'] === 'string' ? { alternativePhone: [data['alternativePhone']] } : {}),
      ...(typeof data['email'] === 'string' ? { email: data['email'] } : {}),
      emailVerified: data['emailVerified'] === true,
      ...(this.firstNonEmptyString(data['facebook'], data['facebookUrl'])
        ? { facebook: this.firstNonEmptyString(data['facebook'], data['facebookUrl']) }
        : {}),
      facebookVerified: data['facebookVerified'] === true,
      ...(this.firstNonEmptyString(data['website'], data['websiteUrl'])
        ? { website: this.firstNonEmptyString(data['website'], data['websiteUrl']) }
        : {}),
      websiteVerified: data['websiteVerified'] === true,
      phoneVerified: data['phoneVerified'] === true,
      locationVerified: data['locationVerified'] === true,
      isCallable: data['isCallable'] === true || data['callable'] === true,
      ...(typeof data['openingHours'] === 'string'
        ? { openingHours: data['openingHours'] }
        : typeof data['operatingHours'] === 'string' ? { openingHours: data['operatingHours'] } : {}),
      ...(typeof (data['facebookUrl'] ?? data['facebook']) === 'string'
        ? { facebookUrl: String(data['facebookUrl'] ?? data['facebook']) }
        : {}),
      ...(typeof (data['websiteUrl'] ?? data['website']) === 'string'
        ? { websiteUrl: String(data['websiteUrl'] ?? data['website']) }
        : {}),
      ...(typeof data['description'] === 'string' ? { description: data['description'] } : {}),
      verificationStatus,
      isActive: data['isActive'] === true || data['active'] === true,
      isPublic: data['isPublic'] === true,
      ...(typeof data['legacyFacilityId'] === 'string' ? { legacyFacilityId: data['legacyFacilityId'] } : {}),
      ...(this.firstNonEmptyString(data['sourceUrl'], data['officialSourceUrl'], data['source'])
        ? { sourceUrl: this.firstNonEmptyString(data['sourceUrl'], data['officialSourceUrl'], data['source']) }
        : {}),
      ...(this.firstNonEmptyString(data['officialSourceUrl'], data['sourceUrl'], data['source'])
        ? { officialSourceUrl: this.firstNonEmptyString(data['officialSourceUrl'], data['sourceUrl'], data['source']) }
        : {}),
      createdAt: this.timestampToDate(data['createdAt'])
    };
  }

  private toCoordinate(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const coordinate = Number(value);
      if (Number.isFinite(coordinate)) return coordinate;
    }
    return undefined;
  }

  private firstNonEmptyString(...values: unknown[]): string | undefined {
    return values.find((value): value is string =>
      typeof value === 'string' && Boolean(value.trim())
    )?.trim();
  }

  private isEmergencyCategory(value: unknown): value is EmergencyCategory {
    return ['medical', 'fire', 'police', 'accident', 'disaster', 'other'].includes(String(value));
  }

  private toEmergencyCategory(value: unknown): EmergencyCategory | undefined {
    if (this.isEmergencyCategory(value)) return value;
    const normalized = String(value ?? '').trim().toLocaleLowerCase().replace(/[\s-]+/g, '_');
    if (['hospital', 'clinic', 'diagnostic_center', 'dental_clinic', 'health_center', 'animal_bite_center', 'lying_in_clinic', 'pharmacy'].includes(normalized)) return 'medical';
    if (['fire_station', 'fire_and_rescue_station', 'fire_and_rescue', 'fire_rescue_station'].includes(normalized)) return 'fire';
    if (normalized === 'police_station') return 'police';
    if (['barangay', 'barangay_hall', 'barangay_health_center'].includes(normalized)) return 'other';
    if (['rescue', 'rescue_center', 'rescue_station', 'accident_rescue'].includes(normalized)) return 'accident';
    return undefined;
  }

  private toHotline(
    id: string,
    data: Record<string, unknown>,
    collectionName: string
  ): Hotline {
    const nameValue = this.firstNonEmptyString(data['name'], data['facilityName'], data['agencyName']);
    const phoneValue = this.firstNonEmptyString(
      data['phoneNumber'], data['phone'], data['contactNumber'], data['primaryPhone']
    );
    const municipalityValue = this.firstNonEmptyString(data['municipality'], data['city']);
    const regionValue = this.firstNonEmptyString(data['region'], data['province'])
      ?? (municipalityValue ? 'Oriental Mindoro' : '');
    const category = this.toEmergencyCategory(
      this.firstNonEmptyString(data['category'], data['type'], data['facilityType'])
    ) ?? 'other';
    const latitude = this.toCoordinate(data['latitude']) ?? this.toCoordinate(data['lat']);
    const longitude = this.toCoordinate(data['longitude']) ?? this.toCoordinate(data['lng']);
    const hasName = typeof nameValue === 'string' && Boolean(nameValue.trim());
    const name = nameValue ?? 'Unnamed emergency record';
    const phoneNumber = phoneValue ?? '';
    const region = typeof regionValue === 'string' ? regionValue.trim() : '';
    const rawLatitude = data['latitude'] ?? data['lat'];
    const rawLongitude = data['longitude'] ?? data['lng'];
    if (!hasName || !region
      || !this.toEmergencyCategory(
        this.firstNonEmptyString(data['category'], data['type'], data['facilityType'])
      )) {
      console.warn('[Firestore] Hotline document has missing or invalid fields.', {
        projectId: environment.firebase.projectId,
        collection: collectionName,
        documentId: id,
        hasName: Boolean(name),
        hasRegion: Boolean(region),
        category: data['category']
      });
    }
    if ((rawLatitude !== undefined && rawLatitude !== '' && latitude === undefined)
      || (rawLongitude !== undefined && rawLongitude !== '' && longitude === undefined)) {
      console.warn('[Firestore] Hotline document contains invalid coordinates.', {
        projectId: environment.firebase.projectId,
        collection: collectionName,
        documentId: id,
        latitude: rawLatitude,
        longitude: rawLongitude
      });
    }
    if (phoneNumber && !this.normalizePhoneNumber(phoneNumber)) {
      console.warn('[Firestore] Hotline document contains an invalid phone number.', {
        projectId: environment.firebase.projectId,
        collection: collectionName,
        documentId: id
      });
    }
    return {
      id,
      name,
      type: this.firstNonEmptyString(data['type'], data['facilityType'], data['category']) ?? '',
      phoneNumber,
      phoneVerified: data['phoneVerified'] === true,
      alternativePhone: Array.isArray(data['alternativePhone'])
        ? data['alternativePhone'].filter((value): value is string => typeof value === 'string')
        : [],
      countryCode: typeof data['countryCode'] === 'string' ? data['countryCode'] : '',
      region,
      ...(municipalityValue ? { municipality: municipalityValue } : {}),
      ...(typeof data['address'] === 'string' ? { address: data['address'] } : {}),
      ...(latitude !== undefined ? { latitude } : {}),
      ...(longitude !== undefined ? { longitude } : {}),
      category,
      description: typeof data['description'] === 'string' ? data['description'] : '',
      officialSourceUrl: this.firstNonEmptyString(data['officialSourceUrl'], data['sourceUrl']) ?? '',
      sourceUrl: this.firstNonEmptyString(data['sourceUrl'], data['officialSourceUrl']) ?? '',
      ...(typeof data['email'] === 'string' ? { email: data['email'] } : {}),
      emailVerified: data['emailVerified'] === true,
      ...(this.firstNonEmptyString(data['facebook'], data['facebookUrl'], data['legacyFacebook'])
        ? { facebook: this.firstNonEmptyString(data['facebook'], data['facebookUrl'], data['legacyFacebook']) }
        : {}),
      facebookVerified: data['facebookVerified'] === true,
      ...(this.firstNonEmptyString(data['website'], data['websiteUrl'], data['legacyWebsite'])
        ? { website: this.firstNonEmptyString(data['website'], data['websiteUrl'], data['legacyWebsite']) }
        : {}),
      websiteVerified: data['websiteVerified'] === true,
      ...(this.firstNonEmptyString(data['openingHours'], data['operatingHours'])
        ? { openingHours: this.firstNonEmptyString(data['openingHours'], data['operatingHours']) }
        : {}),
      locationVerified: data['locationVerified'] === true,
      ...(typeof data['isCallable'] === 'boolean' ? { isCallable: data['isCallable'] } : {}),
      verificationStatus: this.firstNonEmptyString(data['verificationStatus'], data['status']) === 'verified'
        ? 'verified'
        : 'unverified',
      isActive: data['isActive'] === true || data['active'] === true,
      isPublic: data['isPublic'] === true,
      ...(typeof data['legacyFacilityId'] === 'string' ? { legacyFacilityId: data['legacyFacilityId'] } : {}),
      lastVerifiedAt: this.timestampToDate(data['lastVerifiedAt']) ?? undefined
    };
  }

  hotlineToFacility(hotline: Hotline): Facility {
    return {
      id: hotline.id,
      name: hotline.name,
      type: hotline.type || hotline.category,
      category: hotline.category,
      phone: hotline.phoneNumber,
      phoneVerified: hotline.phoneVerified,
      alternativePhone: hotline.alternativePhone,
      countryCode: hotline.countryCode,
      region: hotline.region,
      municipality: hotline.municipality ?? '',
      address: hotline.address,
      latitude: hotline.latitude,
      longitude: hotline.longitude,
      email: hotline.email,
      emailVerified: hotline.emailVerified,
      facebook: hotline.facebook,
      facebookUrl: hotline.facebook,
      facebookVerified: hotline.facebookVerified,
      website: hotline.website,
      websiteUrl: hotline.website,
      websiteVerified: hotline.websiteVerified,
      openingHours: hotline.openingHours,
      sourceUrl: hotline.sourceUrl || hotline.officialSourceUrl,
      officialSourceUrl: hotline.officialSourceUrl,
      description: hotline.description,
      verificationStatus: hotline.verificationStatus,
      isActive: hotline.isActive,
      isPublic: hotline.isPublic,
      locationVerified: hotline.locationVerified,
      isCallable: hotline.isCallable
    };
  }

  private collectReportResults(
    results: [
      PromiseSettledResult<QuerySnapshot<DocumentData>>,
      PromiseSettledResult<QuerySnapshot<DocumentData>>
    ]
  ): EmergencyReport[] {
    const [canonical, legacy] = results;
    if (canonical.status === 'rejected' && legacy.status === 'rejected') {
      throw new Error(`Could not load reports from reports or emergencyReports. ${this.errorMessage(canonical.reason)} ${this.errorMessage(legacy.reason)}`);
    }
    if (canonical.status === 'rejected') {
      console.warn('[Firestore] Canonical reports query failed; returning compatible legacy results.', canonical.reason);
    }
    if (legacy.status === 'rejected') {
      console.warn('[Firestore] Legacy emergencyReports query failed; returning canonical reports.', legacy.reason);
    }
    const availableCount = (canonical.status === 'fulfilled' ? canonical.value.size : 0)
      + (legacy.status === 'fulfilled' ? legacy.value.size : 0);
    if (availableCount === 0 && (canonical.status === 'rejected' || legacy.status === 'rejected')) {
      const failure = canonical.status === 'rejected' ? canonical.reason : legacy.status === 'rejected' ? legacy.reason : 'query failed';
      throw new Error(`No reports could be displayed because a report source failed. ${this.errorMessage(failure)}`);
    }
    const reports: EmergencyReport[] = [];
    if (canonical.status === 'fulfilled') {
      reports.push(...canonical.value.docs.map((entry) => this.toReport(entry.id, entry.data(), 'reports')));
    }
    if (legacy.status === 'fulfilled') {
      reports.push(...legacy.value.docs.map((entry) => this.toReport(entry.id, entry.data(), 'emergencyReports')));
    }
    return reports.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async saveCategory(
    record: Omit<EmergencyCategoryRecord, 'id'>,
    id?: string
  ): Promise<void> {
    this.requireAdmin();
    const db = this.requireDb();
    const data = { ...record, updatedAt: serverTimestamp() };
    if (id) await setDoc(doc(db, 'emergencyCategories', id), data, { merge: true });
    else await addDoc(collection(db, 'emergencyCategories'), { ...data, createdAt: serverTimestamp() });
  }

  async saveHotline(record: Omit<Hotline, 'id' | 'lastVerifiedAt'>, id?: string): Promise<void> {
    this.requireAdmin();
    const db = this.requireDb();
    const data = {
      ...record,
      name: record.name.trim(),
      type: record.type?.trim() ?? '',
      phoneNumber: record.phoneNumber?.trim() ?? '',
      countryCode: record.countryCode?.trim() ?? '',
      region: record.region?.trim() ?? '',
      municipality: record.municipality?.trim() ?? '',
      address: record.address?.trim() ?? '',
      description: record.description?.trim() ?? '',
      officialSourceUrl: record.sourceUrl?.trim() || record.officialSourceUrl?.trim() || '',
      sourceUrl: record.sourceUrl?.trim() || record.officialSourceUrl?.trim() || '',
      email: record.email?.trim() ?? '',
      facebook: record.facebook?.trim() ?? '',
      website: record.website?.trim() ?? '',
      openingHours: record.openingHours?.trim() ?? '',
      phoneVerified: record.phoneVerified === true,
      emailVerified: record.emailVerified === true,
      facebookVerified: record.facebookVerified === true,
      websiteVerified: record.websiteVerified === true,
      locationVerified: record.locationVerified === true,
      isCallable: record.isCallable === true,
      isActive: record.isActive === true,
      ...(record.verificationStatus === 'verified' ? { lastVerifiedAt: serverTimestamp() } : {}),
      updatedAt: serverTimestamp()
    };
    if (id) await setDoc(doc(db, 'emergencyHotlines', id), data, { merge: true });
    else await addDoc(collection(db, 'emergencyHotlines'), { ...data, createdAt: serverTimestamp() });
    this.invalidatePublicHotlinesCache();
  }

  async updateHotlineFlags(
    id: string,
    changes: Partial<Pick<Hotline, 'isActive' | 'verificationStatus' | 'phoneVerified' | 'locationVerified' | 'isCallable'>>
  ): Promise<void> {
    this.requireAdmin();
    const ref = doc(this.requireDb(), 'emergencyHotlines', id);
    const snapshot = await this.readDocument(
      'emergencyHotlines',
      id,
      getDoc(ref)
    );
    if (!snapshot.exists()) throw new Error('This emergency hotline no longer exists. Refresh the directory.');
    const existing = this.toHotline(id, snapshot.data(), 'emergencyHotlines');
    const next = { ...existing, ...changes };
    if (next.isCallable && (!next.isActive || next.verificationStatus !== 'verified' || !next.phoneVerified)) {
      throw new Error('Calls and SMS require an active, verified record and a verified phone number.');
    }
    if (changes.isActive === false || changes.verificationStatus === 'unverified' || changes.phoneVerified === false) {
      next.isCallable = false;
    }
    await setDoc(ref, {
      ...changes,
      ...(next.isCallable !== existing.isCallable ? { isCallable: next.isCallable } : {}),
      ...(changes.verificationStatus === 'verified' ? { lastVerifiedAt: serverTimestamp() } : {}),
      updatedAt: serverTimestamp()
    }, { merge: true });
    this.invalidatePublicHotlinesCache();
  }

  async bulkVerifyAndActivateHotlines(ids: string[]): Promise<number> {
    this.requireAdmin();
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (!uniqueIds.length) throw new Error('Select at least one emergency record to verify.');
    let updated = 0;
    for (let offset = 0; offset < uniqueIds.length; offset += 450) {
      const batch = writeBatch(this.requireDb());
      const chunk = uniqueIds.slice(offset, offset + 450);
      for (const id of chunk) {
        batch.update(doc(this.requireDb(), 'emergencyHotlines', id), {
          verificationStatus: 'verified',
          isActive: true,
          lastVerifiedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }
      await batch.commit();
      updated += chunk.length;
    }
    this.invalidatePublicHotlinesCache();
    return updated;
  }

  async saveGuide(record: Omit<EmergencyGuide, 'id'>, id?: string): Promise<void> {
    this.requireAdmin();
    const db = this.requireDb();
    const data = { ...record, updatedAt: serverTimestamp() };
    if (id) await setDoc(doc(db, 'emergencyGuides', id), data, { merge: true });
    else await addDoc(collection(db, 'emergencyGuides'), { ...data, createdAt: serverTimestamp() });
  }

  async deleteAdminRecord(collectionName: string, id: string): Promise<void> {
    this.requireAdmin();
    if (!['emergencyCategories', 'emergencyHotlines', 'emergencyGuides'].includes(collectionName)) {
      throw new Error('This record type cannot be deleted here.');
    }
    await deleteDoc(doc(this.requireDb(), collectionName, id));
    if (collectionName === 'emergencyHotlines') this.invalidatePublicHotlinesCache();
  }

  async getVerifiedHotlines(): Promise<Hotline[]> {
    if (this.publicHotlinesCache && this.publicHotlinesCache.expiresAt > Date.now()) {
      return this.publicHotlinesCache.records;
    }
    if (this.publicHotlinesRequest) return this.publicHotlinesRequest;
    const request = this.fetchVerifiedHotlines();
    this.publicHotlinesRequest = request;
    try {
      const records = await request;
      this.publicHotlinesCache = { expiresAt: Date.now() + 60_000, records };
      return records;
    } finally {
      this.publicHotlinesRequest = null;
    }
  }

  async refreshPublicHotlines(): Promise<Hotline[]> {
    this.invalidatePublicHotlinesCache();
    return this.getVerifiedHotlines();
  }

  private async withDirectoryReadTimeout<T>(request: Promise<T>): Promise<T> {
    let timeout: number | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<T>((_, reject) => {
          timeout = window.setTimeout(
            () => reject(new Error('Firebase directory request timed out after 5 seconds.')),
            5000
          );
        })
      ]);
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
  }

  private async fetchVerifiedHotlines(): Promise<Hotline[]> {
    const seedRecords = environment.directoryTestingMode && !environment.production
      ? await this.developmentCsvSeed
      : [];
    const publicFallback = environment.production ? await this.publicDirectoryFallback : [];
    const allowTestingRecords = environment.directoryTestingMode && this.isAdmin;
    try {
      const directoryRequest = allowTestingRecords
        ? this.readCollection(
          'emergencyHotlines',
          'all directory records (authenticated local testing mode)',
          getDocs(query(collection(this.requireDb(), 'emergencyHotlines'), limit(500)))
        ).then((snapshot) => [snapshot])
        : Promise.all([
          this.readCollection(
            'emergencyHotlines',
            'isActive == true (active contacts are visible; call/SMS still requires verification)',
            getDocs(query(collection(this.requireDb(), 'emergencyHotlines'), where('isActive', '==', true), limit(500)))
          ),
          this.readCollection(
            'emergencyHotlines',
            'isPublic == true (public review listings; calls/SMS remain disabled until verification)',
            getDocs(query(collection(this.requireDb(), 'emergencyHotlines'), where('isPublic', '==', true), limit(500)))
          )
        ]);
      const snapshots = await this.withDirectoryReadTimeout(directoryRequest);
      const recordsByKey = new Map<string, Hotline>();
      for (const record of seedRecords) {
        recordsByKey.set(facilityDuplicateKey(record.name, record.category, record.municipality ?? record.region), record);
      }
      for (const snapshot of snapshots) {
        for (const entry of snapshot.docs) {
          const record = this.toHotline(entry.id, entry.data(), 'emergencyHotlines');
          if (record.name.length > 0
            && (allowTestingRecords || record.isActive || record.isPublic)) {
            recordsByKey.set(
              facilityDuplicateKey(record.name, record.category, record.municipality ?? record.region),
              record
            );
          }
        }
      }
      const records = [...recordsByKey.values()];
      if (environment.production) {
        if (records.length) {
          this.showingLegacyDirectoryData = false;
          return records;
        }
        if (publicFallback.length) {
          this.showingLegacyDirectoryData = true;
          console.warn('[Directory preview] Firestore has no public hotline records; showing the bundled, unverified contact list.');
          return publicFallback;
        }
      }
      this.showingLegacyDirectoryData = seedRecords.length > 0;
      if (records.length || environment.production || !environment.directoryTestingMode) {
        return records;
      }
    } catch (error) {
      const fallbackRecords = environment.production ? publicFallback : seedRecords;
      if (!fallbackRecords.length) throw error;
      this.showingLegacyDirectoryData = true;
      console.error('[Directory preview] Could not load the Firebase directory; showing the bundled, unverified contact list.', error);
      return fallbackRecords;
    }

    const legacySnapshot = await this.withDirectoryReadTimeout(this.readCollection(
      'emergencyFacilities',
      'all legacy records (local development preview only)',
      getDocs(query(collection(this.requireDb(), 'emergencyFacilities'), limit(500)))
    ));
    const legacyRecords = legacySnapshot.docs
      .map((entry) => this.toHotline(entry.id, entry.data(), 'emergencyFacilities'))
      .filter((record) => record.name.trim().length > 0);
    this.showingLegacyDirectoryData = legacyRecords.length > 0;
    return legacyRecords;
  }

  private async loadDevelopmentCsvSeed(): Promise<Hotline[]> {
    try {
      const csv = await firstValueFrom(this.assetHttp.get(
        '/dev-data/emergencyFacilities.seed.csv',
        { responseType: 'text' }
      ));
      const rows = parseFacilityCsv(csv);
      const invalidRows = rows.filter((row) => row.errors.length > 0);
      if (invalidRows.length) {
        console.warn('[Directory preview] CSV rows with validation errors were excluded.', {
          invalidRows: invalidRows.length,
          totalRows: rows.length
        });
      }
      return rows
        .filter((row) => row.errors.length === 0)
        .map((row) => {
          const facility = row.facility;
          return {
            id: `csv-row-${row.line}`,
            name: facility.name,
            type: facility.type,
            phoneNumber: facility.phone ?? '',
            phoneVerified: false,
            alternativePhone: facility.alternativePhone ?? [],
            countryCode: '',
            region: facility.region ?? '',
            ...(facility.municipality ? { municipality: facility.municipality } : {}),
            ...(facility.address ? { address: facility.address } : {}),
            ...(facility.latitude !== undefined ? { latitude: facility.latitude } : {}),
            ...(facility.longitude !== undefined ? { longitude: facility.longitude } : {}),
            category: facility.category ?? 'other',
            description: facility.description ?? '',
            officialSourceUrl: '',
            sourceUrl: '',
            ...(facility.email ? { email: facility.email } : {}),
            emailVerified: false,
            ...(facility.facebook ? { facebook: facility.facebook } : {}),
            facebookVerified: false,
            ...(facility.website ? { website: facility.website } : {}),
            websiteVerified: false,
            ...(facility.openingHours ? { openingHours: facility.openingHours } : {}),
            locationVerified: false,
            isCallable: false,
            verificationStatus: 'unverified' as const,
            isActive: false,
            isPublic: true
          };
        });
    } catch (error) {
      console.error('[Directory preview] Could not load the bundled development CSV.', error);
      return [];
    }
  }

  private async loadPublicDirectoryFallback(): Promise<Hotline[]> {
    const csv = await firstValueFrom(this.assetHttp.get(
      '/data/emergency-contact-import.csv',
      { responseType: 'text' }
    ));
    const rows = parseFacilityCsv(csv);
    const invalidRows = rows.filter((row) => row.errors.length > 0);
    if (invalidRows.length) {
      console.warn('[Directory fallback] Excluding invalid contact rows.', {
        invalidRows: invalidRows.length,
        totalRows: rows.length
      });
    }
    return rows
      .filter((row) => row.errors.length === 0 && Boolean(row.facility.phone?.trim()))
      .map((row) => {
        const facility = row.facility;
        return {
          id: `public-csv-${row.line}`,
          name: facility.name,
          type: facility.type,
          phoneNumber: facility.phone ?? '',
          phoneVerified: false,
          alternativePhone: facility.alternativePhone ?? [],
          countryCode: 'PH',
          region: facility.region ?? '',
          ...(facility.municipality ? { municipality: facility.municipality } : {}),
          ...(facility.address ? { address: facility.address } : {}),
          ...(facility.latitude !== undefined ? { latitude: facility.latitude } : {}),
          ...(facility.longitude !== undefined ? { longitude: facility.longitude } : {}),
          category: facility.category ?? 'other',
          description: facility.description || 'User-provided listing; not independently verified.',
          officialSourceUrl: facility.officialSourceUrl ?? facility.sourceUrl ?? '',
          sourceUrl: facility.sourceUrl ?? facility.officialSourceUrl ?? '',
          ...(facility.openingHours ? { openingHours: facility.openingHours } : {}),
          isCallable: false,
          verificationStatus: 'unverified' as const,
          isActive: false,
          isPublic: true
        };
      });
  }

  private invalidatePublicHotlinesCache(): void {
    this.publicHotlinesCache = null;
    this.publicHotlinesRequest = null;
    this.filteredHotlineCache.clear();
    this.showingLegacyDirectoryData = false;
  }

  async getPublicHotlines(category?: EmergencyCategory, municipality?: string): Promise<Hotline[]> {
    return this.getFilteredPublicHotlines(category, municipality);
  }

  async getFilteredPublicHotlines(
    category?: EmergencyCategory,
    municipality?: string
  ): Promise<Hotline[]> {
    const normalizedMunicipality = municipality?.trim() ?? '';
    const records = await this.getVerifiedHotlines();
    const normalize = (value: string) => this.normalizeMunicipality(value);
    return records.filter((record) =>
      (!category || record.category === category || (category === 'accident' && ['medical', 'fire', 'police', 'other'].includes(record.category)))
      && (!normalizedMunicipality || normalize(record.municipality ?? '') === normalize(normalizedMunicipality))
    );
  }

  async getPublishedGuides(): Promise<EmergencyGuide[]> {
    const published = query(
      collection(this.requireDb(), 'emergencyGuides'),
      where('isPublished', '==', true)
    );
    const snapshot = await this.readCollection(
      'emergencyGuides',
      'isPublished == true',
      getDocs(published)
    );
    return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() } as EmergencyGuide));
  }

  async submitReport(input: {
    category: EmergencyCategory;
    description?: string;
    latitude?: number;
    longitude?: number;
  }): Promise<string> {
    const user = this.requireCurrentUser();
    const result = await addDoc(collection(this.requireDb(), 'reports'), {
      userId: user.uid,
      category: input.category,
      ...(input.description ? { description: input.description } : {}),
      ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
      ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
      status: 'Submitted',
      createdAt: serverTimestamp()
    });
    return result.id;
  }

  async getUserReports(): Promise<EmergencyReport[]> {
    const user = this.requireCurrentUser();
    const db = this.requireDb();
    const results = await Promise.allSettled([
      this.readCollection('reports', `userId == '${user.uid}'`, getDocs(query(
        collection(db, 'reports'),
        where('userId', '==', user.uid)
      ))),
      this.readCollection('emergencyReports', `userId == '${user.uid}' (legacy)`, getDocs(query(
        collection(db, 'emergencyReports'),
        where('userId', '==', user.uid)
      )))
    ]);
    return this.collectReportResults(results);
  }

  async getAdminReports(): Promise<EmergencyReport[]> {
    this.requireAdmin();
    const db = this.requireDb();
    const results = await Promise.allSettled([
      this.readCollection('reports', 'all documents (administrator)', getDocs(collection(db, 'reports'))),
      this.readCollection('emergencyReports', 'all documents (administrator, legacy collection)', getDocs(collection(db, 'emergencyReports')))
    ]);
    return this.collectReportResults(results);
  }

  async updateReportStatus(
    reportId: string,
    status: EmergencyReport['status'],
    sourceCollection: EmergencyReport['sourceCollection'] = 'reports'
  ): Promise<void> {
    this.requireAdmin();
    await setDoc(doc(this.requireDb(), sourceCollection, reportId), { status }, { merge: true });
  }

  async submitFacilitySuggestion(
    suggestion: Omit<FacilitySuggestion, 'id' | 'reviewStatus' | 'createdAt' | 'submittedBy'>
  ): Promise<string> {
    const user = this.requireCurrentUser();
    const result = await addDoc(collection(this.requireDb(), 'facilitySuggestions'), {
      submittedBy: user.uid,
      ...suggestion,
      reviewStatus: 'pending',
      createdAt: serverTimestamp()
    });
    return result.id;
  }

  async getAdminFacilitySuggestions(): Promise<FacilitySuggestion[]> {
    this.requireAdmin();
    const suggestions = await this.readCollection(
      'facilitySuggestions',
      'all documents (administrator)',
      getDocs(collection(this.requireDb(), 'facilitySuggestions'))
    );
    return suggestions.docs.map((entry) => ({
      id: entry.id,
      ...entry.data(),
      createdAt: this.timestampToDate(entry.data()['createdAt']) ?? undefined
    } as FacilitySuggestion));
  }

  async reviewFacilitySuggestion(
    suggestionId: string,
    reviewStatus: 'approved' | 'rejected',
    reviewNote: string
  ): Promise<void> {
    this.requireAdmin();
    await setDoc(doc(this.requireDb(), 'facilitySuggestions', suggestionId), {
      reviewStatus,
      reviewNote: reviewNote.trim()
    }, { merge: true });
  }

  private toReport(
    id: string,
    data: Record<string, unknown>,
    sourceCollection: EmergencyReport['sourceCollection']
  ): EmergencyReport {
    const validCategory = this.toEmergencyCategory(data['category']);
    const validStatus = ['Submitted', 'Under Review', 'Resolved', 'Closed'].includes(String(data['status']));
    if (!validCategory || !validStatus || typeof data['userId'] !== 'string') {
      console.warn('[Firestore] Report document has missing or invalid fields.', {
        projectId: environment.firebase.projectId,
        collection: sourceCollection,
        documentId: id,
        category: data['category'],
        status: data['status'],
        hasUserId: typeof data['userId'] === 'string'
      });
    }

    return {
      reportId: id,
      sourceCollection,
      userId: String(data['userId'] ?? ''),
      category: validCategory ?? 'other',
      ...(typeof data['description'] === 'string' ? { description: data['description'] } : {}),
      ...(typeof data['latitude'] === 'number' ? { latitude: data['latitude'] } : {}),
      ...(typeof data['longitude'] === 'number' ? { longitude: data['longitude'] } : {}),
      status: validStatus ? data['status'] as EmergencyReport['status'] : 'Submitted',
      createdAt: this.timestampToDate(data['createdAt']) ?? new Date(0)
    };
  }

  private async readCollection(
    collectionName: string,
    conditions: string,
    request: Promise<QuerySnapshot<DocumentData>>
  ): Promise<QuerySnapshot<DocumentData>> {
    try {
      const snapshot = await request;
      console.info('[Firestore] Read succeeded.', {
        projectId: environment.firebase.projectId,
        collection: collectionName,
        conditions,
        returnedDocuments: snapshot.size,
        authenticatedUid: this.currentUser?.uid ?? this.auth?.currentUser?.uid ?? null
      });
      return snapshot;
    } catch (error) {
      console.error('[Firestore] Read failed.', {
        projectId: environment.firebase.projectId,
        collection: collectionName,
        conditions,
        authenticatedUid: this.currentUser?.uid ?? this.auth?.currentUser?.uid ?? null,
        errorCode: this.errorCode(error),
        errorMessage: this.errorMessage(error),
        error
      });
      throw new Error(this.firestoreErrorMessage(collectionName, error));
    }
  }

  private async readDocument(
    collectionName: string,
    documentId: string,
    request: Promise<DocumentSnapshot<DocumentData>>
  ): Promise<DocumentSnapshot<DocumentData>> {
    try {
      const snapshot = await request;
      console.info('[Firestore] Document read succeeded.', {
        projectId: environment.firebase.projectId,
        collection: collectionName,
        documentId,
        returnedDocuments: snapshot.exists() ? 1 : 0,
        authenticatedUid: this.currentUser?.uid ?? this.auth?.currentUser?.uid ?? null
      });
      return snapshot;
    } catch (error) {
      console.error('[Firestore] Document read failed.', {
        projectId: environment.firebase.projectId,
        collection: collectionName,
        documentId,
        authenticatedUid: this.currentUser?.uid ?? this.auth?.currentUser?.uid ?? null,
        errorCode: this.errorCode(error),
        errorMessage: this.errorMessage(error),
        error
      });
      throw new Error(this.firestoreErrorMessage(collectionName, error));
    }
  }

  private firestoreErrorMessage(collectionName: string, error: unknown): string {
    const code = this.errorCode(error);
    if (code.endsWith('/permission-denied')) {
      return `Firestore denied the ${collectionName} request. Check that the deployed rules allow this query and that its filters match the public-read conditions.`;
    }
    if (code.endsWith('/failed-precondition')) {
      return `Firestore requires an index for the ${collectionName} query. Deploy firestore.indexes.json and retry.`;
    }
    if (code.endsWith('/unavailable') || code.endsWith('/deadline-exceeded')
      || code.endsWith('/network-request-failed')) {
      return `Firestore could not reach the network while reading ${collectionName}. Check connectivity and retry.`;
    }
    if (code.endsWith('/invalid-argument')) {
      return `Firestore rejected the ${collectionName} query or document fields: ${this.errorMessage(error)}`;
    }
    return `Firestore failed to read ${collectionName}${code ? ` (${code})` : ''}: ${this.errorMessage(error)}`;
  }

  private errorCode(error: unknown): string {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : '';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private normalizeMunicipality(value: string): string {
    return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  }

  private async saveUserProfile(
    uid: string,
    values: Partial<FirebaseUserProfile> & { fullName?: string; email?: string }
  ): Promise<void> {
    const db = this.requireDb();
    const profile = {
      uid,
      fullName: values.fullName?.trim() ?? '',
      email: values.email ?? this.currentUser?.email ?? '',
      role: this.isAdmin && uid === RESQ_IT_ADMIN_UID ? 'admin' : 'user',
      phoneNumber: values.phoneNumber ?? '',
      emergencyContactName: values.emergencyContactName ?? '',
      emergencyContactNumber: values.emergencyContactNumber ?? '',
      accountUpdatedAt: serverTimestamp(),
      ...(await this.profileCreateState(db, uid))
    };
    await setDoc(doc(db, 'users', uid), profile, { merge: true });
  }

  private async profileCreateState(db: Firestore, uid: string): Promise<Record<string, unknown>> {
    const snapshot = await this.readDocument(
      'users',
      uid,
      getDoc(doc(db, 'users', uid))
    );
    if (snapshot.exists() && snapshot.data()['accountCreatedAt']) return {};
    return { accountCreatedAt: serverTimestamp() };
  }

  private timestampToDate(value: unknown): Date | null {
    if (value instanceof Timestamp) return value.toDate();
    if (value instanceof Date) return value;
    return null;
  }

  private requireCurrentUser(): User {
    if (!this.currentUser) throw new Error('Sign in to use this feature.');
    return this.currentUser;
  }

  private requireAuth(): Auth {
    if (!this.auth) throw new Error('Firebase is not configured. Follow the Firebase setup steps in README.md.');
    return this.auth;
  }

  private requireDb(): Firestore {
    if (!this.db) throw new Error('Firebase is not configured. Follow the Firebase setup steps in README.md.');
    return this.db;
  }

  private requireAdmin(): void {
    if (!this.currentUser || !this.isAdmin) {
      throw new Error('Administrator access is required.');
    }
  }

  private authError(error: unknown): Error {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    const messages: Record<string, string> = {
      'auth/configuration-not-found': 'Firebase Authentication is not enabled for this Firebase project. In Firebase Console, open Authentication > Get started, then enable the Email/Password provider.',
      'auth/api-key-not-valid': 'The Firebase API key is invalid. Copy the Web API key from the Firebase project used by this app.',
      'auth/operation-not-allowed': 'Email/password sign-in is disabled. Enable the Email/Password provider in Firebase Console > Authentication > Sign-in method.',
      'auth/unauthorized-domain': 'This site is not authorized for Firebase Authentication. Add its hostname under Firebase Console > Authentication > Settings > Authorized domains.',
      'auth/email-already-in-use': 'An account with this email already exists.',
      'auth/weak-password': 'Choose a stronger password with at least 8 characters.',
      'auth/invalid-email': 'Enter a valid email address.',
      'auth/invalid-credential': 'Could not sign in with these credentials. Check the email and password, or use password recovery. Firebase returns this response for multiple credential problems.',
      'auth/invalid-login-credentials': 'Could not sign in with these credentials. Check the email and password, or use password recovery. Firebase returns this response for multiple credential problems.',
      'auth/wrong-password': 'The email or password is incorrect.',
      'auth/user-not-found': 'The email or password is incorrect.',
      'auth/user-disabled': 'This Firebase account is disabled. Contact the project administrator.',
      'auth/network-request-failed': 'Could not reach Firebase Authentication. Check your internet connection and try again.',
      'auth/too-many-requests': 'Too many attempts. Wait a few minutes before trying again.'
    };
    if (messages[code]) {
      const mappedError = new Error(messages[code]);
      Object.defineProperty(mappedError, 'code', { value: code });
      return mappedError;
    }
    return error instanceof Error ? error : new Error('Firebase Authentication failed.');
  }
}
