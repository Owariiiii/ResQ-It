import { Injectable } from '@angular/core';
import { AuthTokenStore } from './auth-token.store';
import { FirebaseService } from './firebase.service';

export interface AuthenticatedUser {
  id: number;
  fullName: string;
  email: string;
  role: 'user' | 'admin';
  phoneNumber: string;
  emergencyContactName: string;
  emergencyContactNumber: string;
}

export interface ProfileUpdate {
  fullName: string;
  phoneNumber: string;
  emergencyContactName: string;
  emergencyContactNumber: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  currentUser: AuthenticatedUser | null = null;
  authReady = false;
  initializationError = '';
  private authOperationInProgress = false;
  private authStateListenerRegistered = false;
  private authStateVersion = 0;

  constructor(
    private readonly tokenStore: AuthTokenStore,
    private readonly firebase: FirebaseService
  ) {}

  get isConfigured(): boolean {
    return this.firebase.isConfigured;
  }

  async initialize(): Promise<void> {
    try {
      if (!this.firebase.isConfigured) {
        this.initializationError = 'Firebase is not configured. Check the Firebase web app settings in src/environments/environment.ts.';
        return;
      }
      await this.firebase.waitForInitialAuthState();
      const current = this.firebase.currentUser;
      this.currentUser = current ? this.toAuthenticatedUser(current) : null;
      this.listenToAuthStateChanges();
    } catch (error) {
      this.initializationError = error instanceof Error ? error.message : 'Could not restore your sign-in session.';
      this.currentUser = null;
    } finally {
      this.authReady = true;
    }
  }

  async register(input: {
    fullName: string;
    email: string;
    password: string;
    phoneNumber?: string;
    emergencyContactName?: string;
    emergencyContactNumber?: string;
  }): Promise<AuthenticatedUser> {
    this.authOperationInProgress = true;
    try {
      const firebaseUser = await this.firebase.register(input.fullName, input.email.trim(), input.password, {
        phoneNumber: input.phoneNumber,
        emergencyContactName: input.emergencyContactName,
        emergencyContactNumber: input.emergencyContactNumber
      });
      const profile = await this.firebase.getCurrentUserProfile();
      this.currentUser = this.toAuthenticatedUser(firebaseUser, profile ?? undefined);
      return this.currentUser;
    } finally {
      this.authOperationInProgress = false;
    }
  }

  async login(email: string, password: string): Promise<AuthenticatedUser> {
    this.authOperationInProgress = true;
    try {
      const firebaseUser = await this.firebase.login(email.trim(), password);
      const profile = await this.firebase.getCurrentUserProfile().catch((error: unknown) => {
        console.error('Firebase sign-in succeeded, but the user profile could not be loaded.', {
          uid: firebaseUser.uid,
          error
        });
        return null;
      });
      this.currentUser = this.toAuthenticatedUser(firebaseUser, profile ?? undefined);
      this.initializationError = '';
      return this.currentUser;
    } finally {
      this.authOperationInProgress = false;
    }
  }

  async refreshAdministratorAccess(): Promise<boolean> {
    const user = this.firebase.currentUser;
    if (!user) throw new Error('Sign in before refreshing administrator access.');
    const isAdmin = await this.firebase.refreshAdminClaim(true);
    const profile = await this.firebase.getCurrentUserProfile();
    this.currentUser = this.toAuthenticatedUser(user, profile ?? undefined);
    return isAdmin;
  }

  async forgotPassword(email: string): Promise<void> {
    await this.firebase.resetPassword(email);
  }

  async updateProfile(profile: ProfileUpdate): Promise<AuthenticatedUser> {
    const updated = await this.firebase.updateProfile(profile);
    const current = this.firebase.currentUser;
    this.currentUser = current ? this.toAuthenticatedUser(current, updated) : this.currentUser;
    if (!this.currentUser) throw new Error('Your sign-in session is no longer available.');
    return this.currentUser;
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.firebase.changePassword(currentPassword, newPassword);
    await this.signOut();
  }

  async signOut(): Promise<void> {
    if (this.firebase.auth) {
      await this.firebase.logout();
    }
    this.currentUser = null;
    await this.tokenStore.clear();
    this.authReady = true;
  }

  private toAuthenticatedUser(user: { uid: string; displayName?: string | null; email?: string | null }, profile?: {
    fullName?: string;
    email?: string;
    phoneNumber?: string;
    emergencyContactName?: string;
    emergencyContactNumber?: string;
  }): AuthenticatedUser {
    const firebaseProfile = profile ?? {};
    const role: 'user' | 'admin' = this.firebase.isAdmin ? 'admin' : 'user';
    return {
      id: Number.parseInt(user.uid, 10) || 0,
      fullName: firebaseProfile.fullName || user.displayName || 'ResQ-It User',
      email: firebaseProfile.email || user.email || '',
      role,
      phoneNumber: firebaseProfile.phoneNumber || '',
      emergencyContactName: firebaseProfile.emergencyContactName || '',
      emergencyContactNumber: firebaseProfile.emergencyContactNumber || ''
    };
  }

  private listenToAuthStateChanges(): void {
    if (this.authStateListenerRegistered) return;
    this.authStateListenerRegistered = true;
    this.firebase.subscribeAuthState((user) => {
      const stateVersion = ++this.authStateVersion;
      if (this.authOperationInProgress) return;
      if (!user) {
        this.currentUser = null;
        this.authReady = true;
        return;
      }
      void this.restoreAuthenticatedUser(user, stateVersion);
    });
  }

  private async restoreAuthenticatedUser(
    user: { uid: string; displayName?: string | null; email?: string | null },
    stateVersion: number
  ): Promise<void> {
    try {
      const profile = await this.firebase.getCurrentUserProfile();
      if (stateVersion === this.authStateVersion) {
        this.currentUser = this.toAuthenticatedUser(user, profile ?? undefined);
      }
    } catch (error) {
      if (stateVersion === this.authStateVersion) {
        this.currentUser = this.toAuthenticatedUser(user);
      }
      console.error('Could not restore Firebase profile state.', error);
    } finally {
      if (stateVersion === this.authStateVersion) this.authReady = true;
    }
  }

}
