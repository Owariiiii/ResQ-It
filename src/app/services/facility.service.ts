import { Injectable } from '@angular/core';
import { EmergencyCategory, Facility, UserLocation } from '../models/emergency.models';
import { FirebaseService } from './firebase.service';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class FacilityService {
  private readonly cache = new Map<string, { expiresAt: number; facilities: Facility[] }>();
  private readonly pending = new Map<string, Promise<Facility[]>>();
  private readonly cacheTtlMs = 5 * 60 * 1000;
  private readonly persistentCacheTtlMs = 24 * 60 * 60 * 1000;
  private lastRefreshWasStale = false;
  private lastSuccessfulRefreshAt: number | null = null;

  constructor(private readonly firebase: FirebaseService) {}

  get isShowingStaleData(): boolean {
    return this.lastRefreshWasStale;
  }

  get lastRefreshedAt(): number | null {
    return this.lastSuccessfulRefreshAt;
  }

  async nearby(
    category: EmergencyCategory,
    location?: UserLocation,
    municipality?: string,
    loadedFacilities?: Facility[]
  ): Promise<Facility[]> {
    const records = (loadedFacilities ?? await this.getVerifiedFacilities(
      municipality,
      category === 'accident' ? undefined : category
    )).filter((facility) =>
      !municipality || this.normalizeMunicipality(facility.municipality ?? '') === this.normalizeMunicipality(municipality)
    );
    return records
      .filter((facility) => !facility.category || facility.category === category || (
        category === 'accident' && ['medical', 'fire', 'police', 'other'].includes(facility.category)
      ))
      .map((facility) => location && this.hasCoordinates(facility)
        ? { ...facility, distanceKm: this.distanceKm(location, facility) }
        : facility)
      .sort((a, b) => {
        const statusOrder = Number(b.isActive === true) - Number(a.isActive === true)
          || Number(b.verificationStatus === 'verified') - Number(a.verificationStatus === 'verified')
          || Number(b.phoneVerified === true) - Number(a.phoneVerified === true)
          || Number(Boolean(b.phone)) - Number(Boolean(a.phone));
        const distanceOrder = (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
        return statusOrder || distanceOrder
          || a.name.localeCompare(b.name);
      });
  }

  getPublicFacilities(municipality?: string, category?: EmergencyCategory): Promise<Facility[]> {
    return this.getVerifiedFacilities(municipality, category);
  }

  invalidate(): void {
    for (const key of this.cache.keys()) {
      try {
        localStorage.removeItem(this.storageKey(key));
      } catch (error) {
        console.warn('Could not clear the saved public facility cache.', error);
      }
    }
    this.cache.clear();
  }

  private normalizeMunicipality(value: string): string {
    return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  }

  private async getVerifiedFacilities(municipality?: string, category?: EmergencyCategory): Promise<Facility[]> {
    const allowTestingRecords = environment.directoryTestingMode && this.firebase.isAdmin;
    const key = `${allowTestingRecords ? 'testing' : 'public'}|${category ?? 'all'}|${this.normalizeMunicipality(municipality ?? '')}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.lastRefreshWasStale = false;
      this.lastSuccessfulRefreshAt = cached.expiresAt - this.cacheTtlMs;
      return cached.facilities;
    }
    const pending = this.pending.get(key);
    if (pending) return pending;

    const saved = this.readPersistentCache(key);
    if (saved) {
      this.cache.set(key, {
        expiresAt: saved.savedAt + this.cacheTtlMs,
        facilities: saved.facilities
      });
      this.lastSuccessfulRefreshAt = saved.savedAt;
      if (saved.savedAt + this.cacheTtlMs > Date.now()) {
        this.lastRefreshWasStale = false;
        return saved.facilities;
      }
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        this.lastRefreshWasStale = true;
        return saved.facilities;
      }
      return this.fetchAndCache(key, municipality, category, saved.facilities);
    }
    if (cached && typeof navigator !== 'undefined' && !navigator.onLine) {
      this.lastRefreshWasStale = true;
      return cached.facilities;
    }
    this.lastRefreshWasStale = false;
    return this.fetchAndCache(key, municipality, category, cached?.facilities);
  }

  private fetchAndCache(
    key: string,
    municipality?: string,
    category?: EmergencyCategory,
    staleFacilities?: Facility[]
  ): Promise<Facility[]> {
    const ongoing = this.pending.get(key);
    if (ongoing) return ongoing;
    const allowTestingRecords = environment.directoryTestingMode && this.firebase.isAdmin;
    const request = this.firebase.getPublicFacilities(municipality, category)
      .then((facilities) => {
        const allowDevelopmentRecords = environment.directoryTestingMode && !environment.production
          && (this.firebase.isAdmin || this.firebase.isShowingLegacyDirectoryData);
        const validFacilities = facilities.filter((facility) =>
          Boolean(facility.name.trim())
          && (allowDevelopmentRecords
            || facility.isActive === true)
        );
        this.cache.set(key, {
          expiresAt: Date.now() + this.cacheTtlMs,
          facilities: validFacilities
        });
        this.lastRefreshWasStale = false;
        this.lastSuccessfulRefreshAt = Date.now();
        this.writePersistentCache(key, validFacilities);
        return validFacilities;
      })
      .catch((error: unknown) => {
        if (!staleFacilities) throw error;
        this.lastRefreshWasStale = true;
        return staleFacilities;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private readPersistentCache(key: string): { savedAt: number; facilities: Facility[] } | null {
    try {
      const serialized = localStorage.getItem(this.storageKey(key));
      if (!serialized) return null;
      const value = JSON.parse(serialized) as { savedAt?: unknown; facilities?: unknown };
      if (typeof value.savedAt !== 'number'
        || Date.now() - value.savedAt > this.persistentCacheTtlMs
        || !Array.isArray(value.facilities)) return null;
      const facilities = value.facilities.filter((entry): entry is Facility =>
        typeof entry === 'object'
        && entry !== null
        && typeof (entry as Facility).id === 'string'
        && typeof (entry as Facility).name === 'string'
        && (environment.directoryTestingMode && !environment.production
          && (this.firebase.isAdmin || this.firebase.isShowingLegacyDirectoryData)
          || (entry as Facility).isActive === true)
      );
      return { savedAt: value.savedAt, facilities };
    } catch (error) {
      console.warn('Could not read the saved public facility list.', error);
      return null;
    }
  }

  private writePersistentCache(key: string, facilities: Facility[]): void {
    try {
      localStorage.setItem(this.storageKey(key), JSON.stringify({
        savedAt: Date.now(),
        facilities
      }));
    } catch (error) {
      console.warn('Could not save the public facility list for offline use.', error);
    }
  }

  private storageKey(region: string): string {
    return `resq-it:verified-facilities:v5:${region}`;
  }

  private distanceKm(
    origin: UserLocation,
    facility: Facility & { latitude: number; longitude: number }
  ): number {
    const radians = (degrees: number) => degrees * Math.PI / 180;
    const latitudeDelta = radians(facility.latitude - origin.latitude);
    const longitudeDelta = radians(facility.longitude - origin.longitude);
    const haversine = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(radians(origin.latitude)) * Math.cos(radians(facility.latitude))
      * Math.sin(longitudeDelta / 2) ** 2;
    const boundedHaversine = Math.min(1, Math.max(0, haversine));
    return 6371 * 2 * Math.atan2(
      Math.sqrt(boundedHaversine),
      Math.sqrt(1 - boundedHaversine)
    );
  }

  private hasCoordinates(facility: Facility): facility is Facility & { latitude: number; longitude: number } {
    return typeof facility.latitude === 'number'
      && Number.isFinite(facility.latitude)
      && facility.latitude >= -90
      && facility.latitude <= 90
      && typeof facility.longitude === 'number'
      && Number.isFinite(facility.longitude)
      && facility.longitude >= -180
      && facility.longitude <= 180;
  }
}
