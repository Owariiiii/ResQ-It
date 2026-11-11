import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { EmergencyCategory, EmergencyCategoryRecord, EmergencyGuide, EmergencyReport, FacilitySuggestion, Hotline } from '../models/emergency.models';
import { FirebaseService } from './firebase.service';
import { environment } from '../../environments/environment';

export interface AccountProfile {
  fullName: string;
  email: string;
  phoneNumber: string;
  emergencyContactName: string;
  emergencyContactNumber: string;
}

export interface ReportCreateRequest {
  category: EmergencyCategory;
  description?: string;
  latitude?: number;
  longitude?: number;
}

export type AdminContentType = 'category' | 'hotline' | 'guide';

interface ItemsResponse<T> {
  items: T[];
}

@Injectable({ providedIn: 'root' })
export class PrivateApiService {
  constructor(
    private readonly http: HttpClient,
    private readonly firebase: FirebaseService
  ) {}

  get isConfigured(): boolean {
    return environment.backendApiBaseUrl.trim().length > 0;
  }

  async getAccountProfile(): Promise<AccountProfile> {
    if (this.firebase.isConfigured) {
      const profile = await this.firebase.getCurrentUserProfile();
      if (!profile) throw new Error('Sign in to load your profile.');
      return {
        fullName: profile.fullName,
        email: profile.email,
        phoneNumber: profile.phoneNumber ?? '',
        emergencyContactName: profile.emergencyContactName ?? '',
        emergencyContactNumber: profile.emergencyContactNumber ?? ''
      };
    }
    const result = await this.get<{ user: AccountProfile }>('/auth/me');
    return result.user;
  }

  async updateAccountProfile(profile: Omit<AccountProfile, 'email'>): Promise<AccountProfile> {
    if (this.firebase.isConfigured) {
      const updated = await this.firebase.updateProfile(profile);
      return {
        fullName: updated.fullName,
        email: updated.email,
        phoneNumber: updated.phoneNumber ?? '',
        emergencyContactName: updated.emergencyContactName ?? '',
        emergencyContactNumber: updated.emergencyContactNumber ?? ''
      };
    }
    const result = await this.put<{ user: AccountProfile }>('/users/profile', profile);
    return result.user;
  }

  async getMyReports(): Promise<EmergencyReport[]> {
    if (this.firebase.isConfigured) return this.firebase.getUserReports();
    const result = await this.get<ItemsResponse<EmergencyReport>>('/account/reports');
    return result.items.map((report) => ({
      ...report,
      createdAt: report.createdAt instanceof Date ? report.createdAt : new Date(report.createdAt)
    }));
  }

  async submitReport(report: ReportCreateRequest): Promise<string> {
    if (this.firebase.isConfigured) return this.firebase.submitReport(report);
    const result = await this.post<{ reportId: string }>('/account/reports', report);
    if (!result.reportId) throw new Error('The account API did not return a report reference.');
    return result.reportId;
  }

  async submitFacilitySuggestion(
    suggestion: Omit<FacilitySuggestion, 'id' | 'reviewStatus' | 'createdAt' | 'submittedBy'>
  ): Promise<string> {
    if (this.firebase.isConfigured) return this.firebase.submitFacilitySuggestion(suggestion);
    const result = await this.post<{ suggestionId: string }>('/account/facility-suggestions', suggestion);
    if (!result.suggestionId) throw new Error('The account API did not return a suggestion reference.');
    return result.suggestionId;
  }

  async getAdminDashboard(): Promise<{
    categories: EmergencyCategoryRecord[];
    hotlines: Hotline[];
    guides: EmergencyGuide[];
    hasMoreHotlines: boolean;
  }> {
    this.requireAdmin();
    if (this.firebase.isConfigured) return this.firebase.getAdminDashboard();
    return this.get('/admin/dashboard');
  }

  async saveAdminRecord(type: AdminContentType, record: object, id?: string): Promise<void> {
    this.requireAdmin();
    if (this.firebase.isConfigured) {
      if (type === 'category') {
        await this.firebase.saveCategory(record as Omit<EmergencyCategoryRecord, 'id'>, id);
      } else if (type === 'hotline') {
        await this.firebase.saveHotline(record as Omit<Hotline, 'id' | 'lastVerifiedAt'>, id);
      } else {
        await this.firebase.saveGuide(record as Omit<EmergencyGuide, 'id'>, id);
      }
      return;
    }
    const path = `/admin/${this.collectionPath(type)}`;
    if (id) {
      await this.put<void>(`${path}/${encodeURIComponent(id)}`, record);
    } else {
      await this.post<{ id: string }>(path, record);
    }
  }

  async deleteAdminRecord(type: AdminContentType, id: string): Promise<void> {
    this.requireAdmin();
    if (this.firebase.isConfigured) {
      const collectionName = type === 'category'
        ? 'emergencyCategories'
        : type === 'hotline' ? 'emergencyHotlines' : 'emergencyGuides';
      await this.firebase.deleteAdminRecord(collectionName, id);
      return;
    }
    await this.delete(`/admin/${this.collectionPath(type)}/${encodeURIComponent(id)}`);
  }

  async getAdminPrivateRecords(): Promise<{ reports: EmergencyReport[]; suggestions: FacilitySuggestion[] }> {
    this.requireAdmin();
    if (this.firebase.isConfigured) {
      const [reports, suggestions] = await Promise.all([
        this.firebase.getAdminReports(),
        this.firebase.getAdminFacilitySuggestions()
      ]);
      return { reports, suggestions };
    }
    const [reportsResult, suggestionsResult] = await Promise.all([
      this.get<ItemsResponse<EmergencyReport>>('/admin/reports'),
      this.get<ItemsResponse<FacilitySuggestion>>('/admin/facility-suggestions')
    ]);
    return {
      reports: reportsResult.items.map((report) => ({
        ...report,
        createdAt: report.createdAt instanceof Date ? report.createdAt : new Date(report.createdAt)
      })),
      suggestions: suggestionsResult.items.map((suggestion) => ({
        ...suggestion,
        createdAt: suggestion.createdAt instanceof Date || !suggestion.createdAt
          ? suggestion.createdAt
          : new Date(suggestion.createdAt)
      }))
    };
  }

  async reviewFacilitySuggestion(
    suggestionId: string,
    reviewStatus: 'approved' | 'rejected',
    reviewNote: string
  ): Promise<void> {
    this.requireAdmin();
    if (this.firebase.isConfigured) {
      await this.firebase.reviewFacilitySuggestion(suggestionId, reviewStatus, reviewNote);
      return;
    }
    await this.patch(`/admin/facility-suggestions/${encodeURIComponent(suggestionId)}`, {
      reviewStatus,
      reviewNote: reviewNote.trim()
    });
  }

  async updateReportStatus(
    reportId: string,
    status: EmergencyReport['status'],
    sourceCollection: EmergencyReport['sourceCollection'] = 'reports'
  ): Promise<void> {
    this.requireAdmin();
    if (this.firebase.isConfigured) {
      await this.firebase.updateReportStatus(reportId, status, sourceCollection);
      return;
    }
    await this.patch(`/admin/reports/${encodeURIComponent(reportId)}`, { status });
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (this.firebase.isConfigured) {
      await this.firebase.changePassword(currentPassword, newPassword);
      return;
    }
    await this.put<void>('/users/change-password', { currentPassword, newPassword });
  }

  private async get<T>(path: string): Promise<T> {
    return this.request(this.http.get<T>(this.url(path)));
  }

  private async post<T>(path: string, body: object): Promise<T> {
    return this.request(this.http.post<T>(this.url(path), body));
  }

  private async put<T>(path: string, body: object): Promise<T> {
    return this.request(this.http.put<T>(this.url(path), body));
  }

  private async patch(path: string, body: object): Promise<void> {
    await this.request(this.http.patch<void>(this.url(path), body));
  }

  private async delete(path: string): Promise<void> {
    await this.request(this.http.delete<void>(this.url(path)));
  }

  private async request<T>(request: import('rxjs').Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(request);
    } catch (error) {
      throw this.errorMessage(error);
    }
  }

  private url(path: string): string {
    const base = environment.backendApiBaseUrl.trim().replace(/\/+$/, '');
    if (!base) throw new Error('Set backendApiBaseUrl in src/environments/environment.ts to use account features.');
    let apiUrl: URL;
    try {
      apiUrl = new URL(base);
    } catch {
      throw new Error('The account API base URL must be an absolute URL.');
    }
    if (environment.production && apiUrl.protocol !== 'https:') {
      throw new Error('The account API must use HTTPS in production builds.');
    }
    return `${base}${path}`;
  }

  private collectionPath(type: AdminContentType): string {
    if (type === 'category') return 'categories';
    if (type === 'hotline') return 'hotlines';
    return 'guides';
  }

  private requireAdmin(): void {
    if (!this.firebase.isAdmin || this.firebase.currentUser === null) {
      throw new Error('Verified administrator access is required.');
    }
  }

  private errorMessage(error: unknown): Error {
    if (error instanceof HttpErrorResponse) {
      const body = error.error as { message?: string; error?: string } | null;
      if (body?.message) return new Error(body.message);
      if (error.status === 0) return new Error('Could not reach the account API. Check the backend URL and connection.');
      if (error.status === 401) return new Error('Your session expired. Sign in again.');
      if (error.status === 403) return new Error('The account API denied this request.');
      return new Error(body?.error ?? `Account API request failed (${error.status}).`);
    }
    return error instanceof Error ? error : new Error('The account API request failed.');
  }
}
