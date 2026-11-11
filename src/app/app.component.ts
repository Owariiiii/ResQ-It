import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonApp, IonBadge, IonButton, IonContent, IonFooter, IonHeader, IonIcon, IonInput,
  IonItem, IonLabel, IonList, IonSpinner, IonTabBar, IonTabButton, IonToolbar,
  ToastController, AlertController
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  alertCircleOutline, callOutline, flameOutline, heartOutline, homeOutline, locateOutline,
  mapOutline, medicalOutline, navigateOutline, personCircleOutline, shieldCheckmarkOutline,
  warningOutline, searchOutline, refreshOutline, logInOutline, documentTextOutline,
  chevronDownOutline
} from 'ionicons/icons';
import type * as L from 'leaflet';
import {
  EmergencyCategory, EmergencyCategoryRecord, EmergencyGuide, Facility, FacilitySuggestion,
  Hotline, EmergencyReport, UserLocation
} from './models/emergency.models';
import { FacilityService } from './services/facility.service';
import {
  FacilityMigrationProgress, FacilityMigrationResult, FirebaseService,
  RESQ_IT_ADMIN_UID
} from './services/firebase.service';
import { LocationService } from './services/location.service';
import { PrivateApiService } from './services/private-api.service';
import { AuthService } from './services/auth.service';
import { environment } from '../environments/environment';
import { parseHotlineCsv } from './utils/hotline-csv';
import {
  FacilityCsvRow, facilityCsvTemplate, facilityDuplicateKey, parseFacilityCsv
} from './utils/facility-csv';

interface CategoryOption {
  id: EmergencyCategory;
  title: string;
  description: string;
  icon: string;
}

interface FacilityDraft {
  id: string;
  name: string;
  type: string;
  category: EmergencyCategory;
  latitude: number | undefined;
  longitude: number | undefined;
  address: string;
  barangay: string;
  municipality: string;
  region: string;
  phone: string;
  alternativePhoneText: string;
  email: string;
  facebook: string;
  facebookUrl: string;
  website: string;
  websiteUrl: string;
  openingHours: string;
  sourceUrl: string;
  officialSourceUrl: string;
  description: string;
  phoneVerified: boolean;
  locationVerified: boolean;
  isCallable: boolean;
  isPublic: boolean;
  verificationStatus: 'verified' | 'unverified';
  isActive: boolean;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule, FormsModule, IonApp, IonBadge, IonButton,
    IonContent, IonFooter, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList,
    IonSpinner, IonTabBar, IonTabButton, IonToolbar
  ],
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit, OnDestroy {
  readonly categories: CategoryOption[] = [
    { id: 'medical', title: 'Medical', description: 'Hospitals, clinics and pharmacies', icon: 'medical-outline' },
    { id: 'fire', title: 'Fire', description: 'Fire and rescue stations', icon: 'flame-outline' },
    { id: 'police', title: 'Police', description: 'Police and personal safety', icon: 'shield-checkmark-outline' },
    { id: 'accident', title: 'Accident', description: 'Emergency medical and rescue', icon: 'warning-outline' },
    { id: 'disaster', title: 'Disaster', description: 'Evacuation and response facilities', icon: 'alert-circle-outline' },
    { id: 'other', title: 'Other', description: 'General emergency facilities', icon: 'navigate-outline' }
  ];
  activeTab = 'home';
  guestMode = false;
  adminSection: 'overview' | 'categories' | 'hotlines' | 'guides' | 'suggestions' | 'reports' = 'overview';
  activeCategory: EmergencyCategory = 'medical';
  location: UserLocation | null = null;
  facilities: Facility[] = [];
  selectedFacility: Facility | null = null;
  hotlines: Hotline[] = [];
  nearbyHotlines: Hotline[] = [];
  reports: EmergencyReport[] = [];
  adminCategories: EmergencyCategoryRecord[] = [];
  adminFacilities: Facility[] = [];
  adminLegacyFacilities: Facility[] = [];
  adminLegacyFacilityCount = 0;
  adminFacilitySearch = '';
  adminFacilityMunicipalityFilter = 'all';
  adminFacilityCategoryFilter = 'all';
  adminFacilityVerificationFilter = 'all';
  adminFacilityActiveFilter = 'all';
  adminHotlines: Hotline[] = [];
  adminHasMoreHotlines = false;
  adminHotlineStatusFilter = 'all';
  adminHotlineSearch = '';
  adminGuides: EmergencyGuide[] = [];
  adminSuggestions: FacilitySuggestion[] = [];
  adminReports: EmergencyReport[] = [];
  publicGuides: EmergencyGuide[] = [];
  adminLoading = false;
  adminDataLoaded = false;
  adminSaving = false;
  adminError = '';
  adminEditingId: string | null = null;
  adminEditingType: 'category' | 'facility' | 'hotline' | 'guide' | null = null;
  categoryDraft = this.newCategoryDraft();
  facilityDraft: FacilityDraft = this.newFacilityDraft();
  facilityCoordinatesLoading = false;
  facilityCsvRows: FacilityCsvRow[] = [];
  facilityCsvImporting = false;
  facilityCsvImportMessage = '';
  facilityCsvImportError = '';
  facilityCsvUpdateDuplicates = false;
  facilityCsvImportProgress = 0;
  facilityMigrationInProgress = false;
  facilityMigrationProgress: FacilityMigrationProgress = {
    total: 0,
    processed: 0,
    migrated: 0,
    skipped: 0,
    failed: 0
  };
  facilityMigrationResult: FacilityMigrationResult | null = null;
  facilityMigrationError = '';
  hotlineDraft = this.newHotlineDraft();
  guideDraft = this.newGuideDraft();
  suggestionReviewNote = '';
  hotlineSearchText = '';
  debouncedHotlineSearchText = '';
  hotlineCategoryFilter = 'all';
  hotlineMunicipalityFilter = 'all';
  adminDebouncedHotlineSearch = '';
  adminDebouncedFacilitySearch = '';
  isOnline = true;
  hotlinesStale = false;
  hotlinesDataLoaded = false;
  guidesDataLoaded = false;
  reportsDataLoaded = false;
  private reportsOwnerEmail: string | null = null;
  profileDataLoaded = false;
  private profileOwnerEmail: string | null = null;
  reportSubmitting = false;
  suggestionSubmitting = false;
  hotlineCsvImporting = false;
  hotlineCsvImportMessage = '';
  hotlineCsvImportError = '';
  profileLoading = false;
  profileSaving = false;
  profileError = '';
  profileDraft = { fullName: '', phoneNumber: '', emergencyContactName: '', emergencyContactNumber: '' };
  authError = '';
  authErrorCode = '';
  authenticating = false;
  sendingPasswordReset = false;
  refreshingAdminAccess = false;
  routeSummary = '';
  suggestionDraft = {
    facilityName: '',
    facilityType: 'hospital',
    address: '',
    latitude: '',
    longitude: '',
    contactNumber: '',
    sourceUrl: ''
  };
  readonly emergencyCategories: EmergencyCategory[] = ['medical', 'fire', 'police', 'accident', 'disaster', 'other'];
  loading = false;
  placeSearchLoading = false;
  hotlinesLoading = false;
  hotlinesError = '';
  guidesError = '';
  reportsError = '';
  guidesLoading = false;
  reportsLoading = false;
  nearbyHotlinesLoading = false;
  nearbyHotlinesError = '';
  errorMessage = '';
  locationMessage = 'Location not shared';
  locationSource: 'gps' | 'municipality' | 'search' | 'region' | 'none' = 'none';
  selectedMunicipality = '';
  searchText = '';
  authMode: 'login' | 'register' = 'login';
  showAuth = false;
  email = '';
  password = '';
  confirmPassword = '';
  currentPassword = '';
  newPassword = '';
  confirmNewPassword = '';
  passwordVisible = false;
  fullName = '';
  phoneNumber = '';
  emergencyContactName = '';
  emergencyContactNumber = '';
  privacyAccepted = false;
  readonly firebaseConfigured: boolean;
  readonly currentYear = new Date().getFullYear();
  get activeHotlineCount(): number {
    return this.adminFacilities.filter((facility) => facility.isActive).length;
  }
  get publishedGuideCount(): number {
    return this.adminGuides.filter((guide) => guide.isPublished).length;
  }
  get pendingSuggestionCount(): number {
    return this.adminSuggestions.filter((suggestion) => suggestion.reviewStatus === 'pending').length;
  }
  get facilityCsvValidCount(): number {
    return this.facilityCsvRows.filter((row) => row.errors.length === 0).length;
  }
  get facilityCsvDuplicateCount(): number {
    return this.facilityCsvRows.filter((row) => row.duplicateType !== undefined).length;
  }
  get facilityCsvInvalidCount(): number {
    return this.facilityCsvRows.filter((row) => row.errors.length > 0).length;
  }
  get facilityCsvImportableCount(): number {
    return this.facilityCsvRows.filter((row) =>
      row.errors.length === 0
      && row.duplicateType !== 'csv'
      && (row.duplicateType !== 'existing' || this.facilityCsvUpdateDuplicates)
      && !row.imported
      && !row.updated
      && !row.skipped
    ).length;
  }
  get facilityCsvHasExistingDuplicates(): boolean {
    return this.facilityCsvRows.some((row) => row.duplicateType === 'existing');
  }
  get isVerifiedAdmin(): boolean {
    return this.firebase.isAdmin && this.firebase.currentUser !== null;
  }
  get isExpectedAdminAccount(): boolean {
    return this.firebase.currentUser?.uid === RESQ_IT_ADMIN_UID;
  }
  get designatedAdminUid(): string {
    return RESQ_IT_ADMIN_UID;
  }
  get adminGrantCommand(): string {
    return `cd backend; node --import tsx scripts/grant-admin.ts ${RESQ_IT_ADMIN_UID}`;
  }
  get filteredAdminFacilities(): Facility[] {
    return this.adminFacilities
      .filter((facility) => this.matchesFacilityFilters(
        facility,
        facility.verificationStatus ?? 'unverified',
        facility.isActive === true
      ))
      .sort((a, b) => Number(b.isActive === true) - Number(a.isActive === true)
        || Number(b.verificationStatus === 'verified') - Number(a.verificationStatus === 'verified')
        || Number(b.phoneVerified === true) - Number(a.phoneVerified === true)
        || a.name.localeCompare(b.name));
  }
  get adminFacilityMunicipalities(): string[] {
    return [...new Set(this.adminFacilities
      .map((facility) => facility.municipality)
      .filter((value): value is string => Boolean(value?.trim())))].sort((a, b) => a.localeCompare(b));
  }
  get publicHotlineMunicipalities(): string[] {
    return [...new Set(this.hotlines
      .map((hotline) => hotline.municipality)
      .filter((value): value is string => Boolean(value?.trim())))].sort((a, b) => a.localeCompare(b));
  }
  get isDirectoryTestingMode(): boolean {
    return environment.directoryTestingMode && this.isVerifiedAdmin;
  }
  get isShowingTestingDirectoryWarning(): boolean {
    return this.isDirectoryTestingMode || this.firebase.isShowingLegacyDirectoryData;
  }
  get hasActiveUnverifiedMapContacts(): boolean {
    return this.facilities.some((facility) => facility.isActive
      && (facility.verificationStatus !== 'verified' || facility.phoneVerified !== true));
  }
  get filteredAdminHotlines(): Hotline[] {
    const search = this.adminDebouncedHotlineSearch.trim().toLocaleLowerCase();
    return this.adminHotlines.filter((hotline) => {
      const matchesSearch = !search || [
        hotline.name, hotline.phoneNumber, hotline.region, hotline.countryCode, hotline.category
      ].some((value) => value?.toLocaleLowerCase().includes(search));
      const matchesStatus = this.adminHotlineStatusFilter === 'all'
        || (this.adminHotlineStatusFilter === 'active' && hotline.isActive)
        || (this.adminHotlineStatusFilter === 'inactive' && !hotline.isActive)
        || (this.adminHotlineStatusFilter === 'verified' && hotline.verificationStatus === 'verified')
        || (this.adminHotlineStatusFilter === 'unverified' && hotline.verificationStatus !== 'verified');
      return matchesSearch && matchesStatus;
    }).sort((a, b) => Number(b.isActive) - Number(a.isActive)
      || Number(b.verificationStatus === 'verified') - Number(a.verificationStatus === 'verified')
      || Number(b.phoneVerified === true) - Number(a.phoneVerified === true)
      || Number(Boolean(b.phoneNumber)) - Number(Boolean(a.phoneNumber))
      || a.name.localeCompare(b.name));
  }
  get filteredHotlines(): Hotline[] {
    const search = this.debouncedHotlineSearchText.trim().toLocaleLowerCase();
    return this.hotlines.filter((hotline) => {
      const matchesSearch = !search || [
        hotline.name, hotline.description, hotline.region, hotline.municipality,
        hotline.address, hotline.phoneNumber, hotline.countryCode, hotline.category
      ].some((value) => value?.toLocaleLowerCase().includes(search));
      return matchesSearch
        && (this.hotlineCategoryFilter === 'all' || hotline.category === this.hotlineCategoryFilter)
        && (this.hotlineMunicipalityFilter === 'all' || hotline.municipality === this.hotlineMunicipalityFilter);
    }).sort((a, b) => Number(b.isActive) - Number(a.isActive)
      || Number(b.verificationStatus === 'verified') - Number(a.verificationStatus === 'verified')
      || Number(b.phoneVerified === true) - Number(a.phoneVerified === true)
      || Number(Boolean(b.phoneNumber)) - Number(Boolean(a.phoneNumber))
      || a.name.localeCompare(b.name));
  }
  get nearbyEmergencyHotlines(): Hotline[] {
    return this.nearbyHotlines.filter((hotline) => {
      const region = hotline.region.toLocaleLowerCase();
      const isOrientalMindoro = region.includes('oriental mindoro')
        || region.includes('mindoro oriental');
      const matchesCategory = this.activeCategory === 'accident'
        ? ['medical', 'fire', 'police', 'accident', 'other'].includes(hotline.category)
        : hotline.category === this.activeCategory || hotline.category === 'other';
      return isOrientalMindoro && matchesCategory;
    });
  }
  get connectionMessage(): string {
    if (!this.isOnline) return this.facilityService.isShowingStaleData
      ? 'Offline — showing saved facility data, which may be outdated.'
      : 'You are offline. Previously loaded information remains available.';
    if (this.facilityService.isShowingStaleData) return 'Could not refresh nearby facilities. Showing saved information that may be outdated.';
    if (this.hotlinesStale) return 'Could not refresh the hotline directory. Showing the previously loaded information.';
    return '';
  }
  private map?: L.Map;
  private markers?: L.LayerGroup;
  private routeLine?: L.Polyline;
  private searchGeneration = 0;
  private lastFacilitySearchKey = '';
  private geocodeCache = new Map<string, { savedAt: number; result: GeocodingResult }>();
  private lastGeocodeRequestAt = 0;
  private leafletModule?: Promise<typeof import('leaflet')>;
  private hotlinesLoadGeneration = 0;
  private locationWatchId: number | null = null;
  private hotlineSearchTimer?: number;
  private adminHotlineSearchTimer?: number;
  private adminFacilitySearchTimer?: number;
  private onlineHandler = (): void => {
    this.isOnline = true;
    void this.retryCurrentPage();
  };
  private offlineHandler = (): void => {
    this.isOnline = false;
  };
  private locationRefreshTimer?: number;
  private readonly municipalities = [
    { name: 'Baco', latitude: 13.357, longitude: 121.096 },
    { name: 'Bansud', latitude: 12.852, longitude: 121.456 },
    { name: 'Bongabong', latitude: 12.735, longitude: 121.372 },
    { name: 'Bulalacao', latitude: 12.326, longitude: 121.344 },
    { name: 'Calapan City', latitude: 13.411, longitude: 121.18 },
    { name: 'Gloria', latitude: 12.923, longitude: 121.469 },
    { name: 'Mansalay', latitude: 12.521, longitude: 121.438 },
    { name: 'Naujan', latitude: 13.323, longitude: 121.303 },
    { name: 'Pinamalayan', latitude: 13.039, longitude: 121.489 },
    { name: 'Pola', latitude: 13.145, longitude: 121.44 },
    { name: 'Puerto Galera', latitude: 13.503, longitude: 120.954 },
    { name: 'Roxas', latitude: 12.583, longitude: 121.517 },
    { name: 'San Teodoro', latitude: 13.438, longitude: 120.96 },
    { name: 'Socorro', latitude: 13.067, longitude: 121.398 },
    { name: 'Victoria', latitude: 13.177, longitude: 121.279 }
  ];
  readonly municipalityNames = this.municipalities.map((municipality) => municipality.name);

  constructor(
    private readonly facilityService: FacilityService,
    private readonly locationService: LocationService,
    readonly firebase: FirebaseService,
    readonly auth: AuthService,
    private readonly privateApi: PrivateApiService,
    private readonly toastController: ToastController,
    private readonly alertController: AlertController,
    private readonly zone: NgZone
  ) {
    this.firebaseConfigured = firebase.isConfigured;
    addIcons({
      alertCircleOutline, callOutline, flameOutline, heartOutline, homeOutline,
      locateOutline, mapOutline, medicalOutline, navigateOutline, personCircleOutline,
      shieldCheckmarkOutline, warningOutline, searchOutline, refreshOutline,
      logInOutline, documentTextOutline, chevronDownOutline
    });
  }

  ngOnInit(): void {
    this.playIntro();
    this.isOnline = typeof navigator === 'undefined' || navigator.onLine;
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
  }

  async chooseCategory(category: EmergencyCategory): Promise<void> {
    this.activeCategory = category;
    this.activeTab = 'map';
    this.startLocationWatch();
    await this.findFacilities();
  }

  async openNearbyEmergency(): Promise<void> {
    this.activeTab = 'map';
    await this.refreshCurrentLocation();
  }

  async enterGuestMode(): Promise<void> {
    this.guestMode = true;
    this.activeTab = 'hotlines';
    await this.openHotlines(true);
  }

  exitGuestMode(): void {
    this.guestMode = false;
    this.activeTab = 'home';
    this.stopLocationWatch();
  }

  leaveHotlines(): void {
    if (this.guestMode) {
      void this.openNearbyEmergency();
      return;
    }
    this.activeTab = 'home';
  }

  ngOnDestroy(): void {
    this.stopLocationWatch();
    if (this.locationRefreshTimer !== undefined) window.clearTimeout(this.locationRefreshTimer);
    if (this.hotlineSearchTimer !== undefined) window.clearTimeout(this.hotlineSearchTimer);
    if (this.adminHotlineSearchTimer !== undefined) window.clearTimeout(this.adminHotlineSearchTimer);
    if (this.adminFacilitySearchTimer !== undefined) window.clearTimeout(this.adminFacilitySearchTimer);
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
  }

  leaveNearbyEmergency(): void {
    this.activeTab = this.guestMode ? 'hotlines' : 'home';
    this.stopLocationWatch();
  }

  async findFacilities(): Promise<void> {
    const generation = ++this.searchGeneration;
    const needsGps = this.locationSource !== 'municipality' && this.locationSource !== 'search';
    const searchKey = [
      this.activeCategory,
      this.locationSource,
      this.selectedMunicipality,
      this.locationSource === 'search' ? this.searchText.trim().toLocaleLowerCase() : ''
    ].join('|');
    if (this.lastFacilitySearchKey && this.lastFacilitySearchKey !== searchKey) {
      this.facilities = [];
      this.nearbyHotlines = [];
      this.markers?.clearLayers();
    }
    this.lastFacilitySearchKey = searchKey;
    this.errorMessage = '';
    this.selectedFacility = null;
    this.routeLine?.remove();
    this.routeLine = undefined;
    this.routeSummary = '';
    this.loading = true;
    this.nearbyHotlinesLoading = true;
    try {
      let origin = this.location;
      if (needsGps) {
        this.location = null;
        this.locationSource = 'none';
        this.locationMessage = 'Getting your current GPS location…';
      }

      const locationRequest: Promise<{ location: UserLocation | null; error?: unknown }> = needsGps
        ? this.withLoadTimeout(
            this.locationService.getCurrentLocation(),
            'Getting current location'
          ).then((location) => ({ location }))
            .catch((error: unknown) => ({ location: null, error }))
        : Promise.resolve({ location: origin });
      const municipality = this.locationSource === 'municipality' ? this.selectedMunicipality : undefined;
      const facilities = await this.withLoadTimeout(
        this.isVerifiedAdmin
          ? this.getAdminMapFacilities(undefined)
          : this.facilityService.nearby(
              this.activeCategory,
              origin ?? undefined,
              municipality
            ),
        'Loading emergency directory'
      );
      if (generation !== this.searchGeneration) return;
      this.facilities = facilities;
      this.markers?.clearLayers();
      this.nearbyHotlines = facilities.map((facility) => this.facilityToHotline(facility));
      this.nearbyHotlinesError = '';
      this.loading = false;
      this.nearbyHotlinesLoading = false;
      setTimeout(() => this.renderMap(), 0);

      const locationResult = await locationRequest;
      if (generation !== this.searchGeneration) return;
      origin = locationResult.location;
      if (origin) {
        this.location = origin;
        if (needsGps) {
          this.locationSource = 'gps';
          this.locationMessage = `Live GPS location (±${Math.round(origin.accuracyMeters ?? 0)} m)`;
          this.startLocationWatch();
        }
        this.facilities = this.isVerifiedAdmin
          ? await this.getAdminMapFacilities(origin, facilities)
          : await this.facilityService.nearby(
              this.activeCategory,
              origin,
              municipality,
              facilities
            );
        this.nearbyHotlines = this.facilities.map((facility) => this.facilityToHotline(facility));
        setTimeout(() => this.renderMap(), 0);
      } else if (needsGps) {
        this.location = null;
        this.locationSource = 'none';
        this.locationMessage = 'Location unavailable. Showing verified contacts without distance; choose a municipality or enable GPS.';
        if (locationResult.error) {
          console.info('Emergency directory loaded without GPS location.', locationResult.error);
        }
      }
    } catch (error) {
      if (generation === this.searchGeneration) {
        if (needsGps) {
          this.location = null;
          this.locationSource = 'none';
          this.locationMessage = 'Location unavailable. Choose a municipality or enable GPS.';
        }
        this.errorMessage = error instanceof Error ? error.message : 'Unable to search nearby facilities.';
        this.nearbyHotlinesError = this.errorMessage;
      }
    } finally {
      if (generation === this.searchGeneration) {
        this.loading = false;
        this.nearbyHotlinesLoading = false;
      }
    }
  }

  private async getAdminMapFacilities(
    origin?: UserLocation,
    loadedFacilities?: Facility[]
  ): Promise<Facility[]> {
    const records = loadedFacilities ?? await this.firebase.getAdminFacilities();
    const legacyRecords = environment.directoryTestingMode && !environment.production
      ? await this.firebase.getAdminLegacyFacilities()
      : [];
    const mapRecords = [
      ...records,
      ...legacyRecords.map((facility) => ({ ...facility, id: `legacy-${facility.id}` }))
    ];
    const municipality = this.locationSource === 'municipality' ? this.selectedMunicipality : '';
    return mapRecords
      .filter((facility) => {
        const category = facility.category ?? 'other';
        const matchesCategory = this.activeCategory === 'accident'
          ? ['medical', 'fire', 'police', 'accident', 'other'].includes(category)
          : category === this.activeCategory || category === 'other';
        const matchesMunicipality = !municipality
          || (facility.municipality ?? '').trim().toLocaleLowerCase() === municipality.trim().toLocaleLowerCase();
        return matchesCategory && matchesMunicipality;
      })
      .map((facility) => origin && this.facilityHasCoordinates(facility)
        ? { ...facility, distanceKm: this.distanceBetween(origin, facility) }
        : facility)
      .sort((a, b) => Number(b.isActive === true) - Number(a.isActive === true)
        || Number(b.verificationStatus === 'verified') - Number(a.verificationStatus === 'verified')
        || Number(b.phoneVerified === true) - Number(a.phoneVerified === true)
        || (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity)
        || a.name.localeCompare(b.name));
  }

  async refreshCurrentLocation(): Promise<void> {
    this.stopLocationWatch();
    this.selectedMunicipality = '';
    this.location = null;
    this.locationSource = 'none';
    this.facilities = [];
    this.nearbyHotlines = [];
    this.markers?.clearLayers();
    await this.findFacilities();
  }

  async selectMunicipality(municipality: string): Promise<void> {
    this.stopLocationWatch();
    this.selectedMunicipality = municipality;
    const area = this.municipalities.find((item) => item.name === municipality);
    if (!area) {
      this.location = null;
      this.locationSource = 'none';
      this.locationMessage = 'Select your municipality to search by area';
      this.facilities = [];
      this.nearbyHotlines = [];
      this.markers?.clearLayers();
      await this.findFacilities();
      return;
    }
    this.location = { latitude: area.latitude, longitude: area.longitude };
    this.locationSource = 'municipality';
    this.locationMessage = `Approximate results for ${area.name}, Oriental Mindoro (not live GPS)`;
    this.activeTab = 'map';
    await this.findFacilities();
  }

  private startLocationWatch(): void {
    if (this.locationWatchId !== null || typeof navigator === 'undefined' || !navigator.geolocation) return;
    this.locationWatchId = navigator.geolocation.watchPosition(
      (position) => {
        if (this.activeTab !== 'map') {
          this.stopLocationWatch();
          return;
        }
        if (this.locationSource !== 'gps') return;
        const nextLocation: UserLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy
        };
        const moved = !this.location || this.distanceBetween(this.location, nextLocation) >= 0.25;
        this.location = nextLocation;
        this.locationMessage = `Live GPS location (±${Math.round(nextLocation.accuracyMeters ?? 0)} m)`;
        if (moved && this.activeTab === 'map') {
          if (this.locationRefreshTimer !== undefined) window.clearTimeout(this.locationRefreshTimer);
          this.locationRefreshTimer = window.setTimeout(() => {
            this.facilities = this.facilities
              .map((facility) => this.facilityHasCoordinates(facility)
                ? { ...facility, distanceKm: this.distanceBetween(nextLocation, facility) }
                : facility)
              .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
            setTimeout(() => this.renderMap(), 0);
          }, 1200);
        }
      },
      (error) => {
        console.warn('Live location update unavailable.', error.message);
        if (error.code === error.PERMISSION_DENIED) this.stopLocationWatch();
      },
      { enableHighAccuracy: false, maximumAge: 30000, timeout: 15000 }
    );
  }

  private stopLocationWatch(): void {
    if (this.locationWatchId === null || typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.clearWatch(this.locationWatchId);
    this.locationWatchId = null;
  }

  private distanceBetween(a: UserLocation, b: UserLocation): number {
    const radians = (degrees: number) => degrees * Math.PI / 180;
    const latitudeDelta = radians(b.latitude - a.latitude);
    const longitudeDelta = radians(b.longitude - a.longitude);
    const haversine = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude))
      * Math.sin(longitudeDelta / 2) ** 2;
    const boundedHaversine = Math.min(1, Math.max(0, haversine));
    return 6371 * 2 * Math.atan2(
      Math.sqrt(boundedHaversine),
      Math.sqrt(1 - boundedHaversine)
    );
  }

  async searchPlace(): Promise<void> {
    const query = this.searchText.trim();
    if (!query) {
      await this.findFacilities();
      return;
    }
    const categorySearch = query.toLocaleLowerCase();
    const nearbyCategory = /hospital|clinic|pharmacy|medical|healthcare/.test(categorySearch)
      ? 'medical'
      : /fire station|firefighter/.test(categorySearch)
        ? 'fire'
        : /police station|police/.test(categorySearch)
          ? 'police'
          : /ambulance|rescue|accident/.test(categorySearch)
            ? 'accident'
            : null;
    if (nearbyCategory) {
      this.searchText = '';
      await this.chooseCategory(nearbyCategory);
      return;
    }
    const generation = ++this.searchGeneration;
    this.placeSearchLoading = true;
    this.facilities = [];
    this.selectedFacility = null;
    this.markers?.clearLayers();
    this.routeLine?.remove();
    this.routeLine = undefined;
    this.routeSummary = '';
    this.loading = true;
    this.errorMessage = '';
    try {
      const result = await this.geocode(query);
      if (generation !== this.searchGeneration) return;
      if (!result) throw new Error('No matching place found. Try a nearby town or address.');
      this.stopLocationWatch();
      this.location = { latitude: Number(result.lat), longitude: Number(result.lon) };
      this.locationSource = 'search';
      this.selectedMunicipality = '';
      this.locationMessage = `Search area: ${result.display_name}`;
      await this.findFacilities();
    } catch (error) {
      if (generation === this.searchGeneration) {
        this.errorMessage = error instanceof Error ? error.message : 'Place search failed.';
        this.loading = false;
      }
    } finally {
      this.placeSearchLoading = false;
    }
  }

  async openFacility(facility: Facility): Promise<void> {
    this.selectedFacility = facility;
  }

  facilityPhoneLink(phone?: string): string | null {
    const normalizedPhone = this.normalizePhone(phone);
    return normalizedPhone ? `tel:${normalizedPhone}` : null;
  }

  facilitySmsLink(phone?: string): string | null {
    const normalizedPhone = this.normalizePhone(phone);
    return normalizedPhone ? `sms:${normalizedPhone}` : null;
  }

  facilityCategoryLabel(facility: Facility): string {
    const category = facility.category ?? this.activeCategory;
    const type = facility.type.replaceAll('_', ' ');
    return `${category[0].toUpperCase()}${category.slice(1)} | ${type.replace(/\b\w/g, (letter) => letter.toUpperCase())}`;
  }

  facilityDirectionsUrl(facility: Facility): string {
    if (!this.facilityHasCoordinates(facility)) {
      return `https://www.openstreetmap.org/search?query=${encodeURIComponent(
        [facility.name, facility.address, facility.municipality, facility.region].filter(Boolean).join(', ')
      )}`;
    }
    const origin = this.location
      ? `${this.location.latitude},${this.location.longitude}`
      : '';
    return `https://www.openstreetmap.org/directions?from=${origin}&to=${facility.latitude},${facility.longitude}`;
  }

  facilityHasCoordinates(facility: Facility): facility is Facility & { latitude: number; longitude: number } {
    return typeof facility.latitude === 'number'
      && Number.isFinite(facility.latitude)
      && facility.latitude >= -90
      && facility.latitude <= 90
      && typeof facility.longitude === 'number'
      && Number.isFinite(facility.longitude)
      && facility.longitude >= -180
      && facility.longitude <= 180;
  }

  async openPhoneDialer(number: string | undefined): Promise<void> {
    const normalizedNumber = this.normalizePhone(number);
    if (!normalizedNumber) {
      await this.showMessage('A valid phone number is not available for this contact.');
      return;
    }
    window.location.assign(`tel:${normalizedNumber}`);
  }

  async openSmsComposer(number: string | undefined): Promise<void> {
    const normalizedNumber = this.normalizePhone(number);
    if (!normalizedNumber) {
      await this.showMessage('A valid phone number is not available for this contact.');
      return;
    }
    window.location.assign(`sms:${normalizedNumber}`);
  }

  private normalizePhone(phone?: string): string | null {
    const value = phone?.trim();
    if (!value) return null;
    const normalized = value.replace(/[\s().-]/g, '');
    const digits = normalized.replace(/^\+/, '');
    if (!/^\+?\d{3,15}$/.test(normalized) || digits.length < 3) return null;
    return normalized;
  }

  private async fetchVerifiedHotlines(forceRefresh = false): Promise<Hotline[]> {
    return this.withLoadTimeout(
      forceRefresh ? this.firebase.refreshPublicHotlines() : this.firebase.getPublicHotlines(),
      'Loading verified contacts'
    );
  }

  private facilityToHotline(facility: Facility): Hotline {
    return {
      id: facility.id,
      name: facility.name,
      type: facility.type,
      phoneNumber: facility.phone ?? '',
      phoneVerified: facility.phoneVerified === true,
      alternativePhone: facility.alternativePhone ?? [],
      countryCode: facility.countryCode ?? '',
      region: facility.region?.toLocaleLowerCase().includes('oriental mindoro')
        ? facility.region
        : facility.municipality ? 'Oriental Mindoro' : facility.region ?? '',
      municipality: facility.municipality,
      address: facility.address,
      latitude: facility.latitude,
      longitude: facility.longitude,
      category: facility.category ?? 'other',
      description: facility.description ?? '',
      officialSourceUrl: facility.officialSourceUrl ?? facility.sourceUrl ?? '',
      sourceUrl: facility.sourceUrl ?? facility.officialSourceUrl ?? '',
      email: facility.email,
      emailVerified: facility.emailVerified === true,
      facebook: facility.facebook,
      facebookVerified: facility.facebookVerified === true,
      website: facility.website,
      websiteVerified: facility.websiteVerified === true,
      openingHours: facility.openingHours,
      locationVerified: facility.locationVerified === true,
      isCallable: facility.isCallable === true,
      verificationStatus: facility.verificationStatus ?? 'unverified',
      isActive: facility.isActive === true
    };
  }

  private async withLoadTimeout<T>(request: Promise<T>, label: string): Promise<T> {
    let timeout: number | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<T>((_, reject) => {
          timeout = window.setTimeout(
            () => reject(new Error(`${label} timed out. Check your connection and try again.`)),
            8000
          );
        })
      ]);
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
  }

  async openHotlines(forceRefresh = false): Promise<void> {
    this.activeTab = 'hotlines';
    if (this.hotlinesDataLoaded && !forceRefresh) {
      this.hotlinesError = this.hotlinesStale
        ? 'The directory could not be refreshed. Showing previously loaded contacts.'
        : '';
      return;
    }
    if (!this.firebaseConfigured) {
      this.hotlinesLoading = false;
      this.hotlinesError = 'The verified hotline directory is not configured. Contact local official services directly.';
      this.hotlines = [];
      return;
    }
    if (this.hotlinesLoading) return;
    const generation = ++this.hotlinesLoadGeneration;
    this.hotlinesLoading = true;
    this.hotlinesError = '';
    try {
      const entries = await this.fetchVerifiedHotlines(forceRefresh);
      if (generation !== this.hotlinesLoadGeneration) return;
      this.zone.run(() => {
        this.hotlines = entries;
        this.hotlinesDataLoaded = true;
        this.hotlinesStale = false;
        this.hotlinesError = '';
      });
    } catch (error) {
      if (generation !== this.hotlinesLoadGeneration) return;
      this.zone.run(() => {
        this.hotlinesStale = this.hotlinesDataLoaded;
        this.hotlinesError = error instanceof Error ? error.message : 'Unable to load verified hotlines.';
      });
    } finally {
      if (generation === this.hotlinesLoadGeneration) {
        this.zone.run(() => {
          this.hotlinesLoading = false;
        });
      }
    }
  }

  async openGuides(forceRefresh = false): Promise<void> {
    this.activeTab = 'guides';
    if (this.guidesDataLoaded && !forceRefresh) return;
    if (this.guidesLoading) return;
    this.guidesLoading = true;
    this.guidesError = '';
    try {
      this.publicGuides = this.firebaseConfigured
        ? await this.withLoadTimeout(this.firebase.getPublishedGuides(), 'Loading emergency guides')
        : [];
      this.guidesDataLoaded = true;
      if (!this.publicGuides.length) this.guidesError = 'No reviewed emergency guides are available yet.';
    } catch (error) {
      this.guidesError = error instanceof Error ? error.message : 'Unable to load emergency guides.';
    } finally {
      this.guidesLoading = false;
    }
  }

  async routeToFacility(facility: Facility): Promise<void> {
    if (!this.facilityHasCoordinates(facility)) {
      await this.showMessage('This facility has no verified map coordinates yet.');
      return;
    }
    if (!this.location || !this.map) {
      await this.showMessage('Choose a search location and load the map before requesting a route.');
      return;
    }
    this.loading = true;
    this.routeSummary = '';
    try {
      const url = `${environment.osrmUrl}/${this.location.longitude},${this.location.latitude};${facility.longitude},${facility.latitude}?overview=full&geometries=geojson`;
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Routing service returned ${response.status}.`);
      const payload = await response.json() as OsrmRouteResponse;
      const route = payload.routes?.[0];
      if (!route || route.geometry.coordinates.length < 2) throw new Error('No route is available for this facility.');
      if (this.routeLine) this.map.removeLayer(this.routeLine);
      const leaflet = await this.loadLeaflet();
      const latLngs = route.geometry.coordinates.map(([longitude, latitude]) => leaflet.latLng(latitude, longitude));
      this.routeLine = leaflet.polyline(latLngs, { color: '#0F8B8D', weight: 5, opacity: .85 }).addTo(this.map);
      this.map.fitBounds(this.routeLine.getBounds(), { padding: [24, 24] });
      this.routeSummary = `Estimated driving route: ${(route.distance / 1000).toFixed(1)} km · about ${Math.max(1, Math.round(route.duration / 60))} min. Travel time is an estimate.`;
      await this.showMessage('Route displayed. Travel time is an estimate, not a guarantee.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not calculate a route.';
      await this.showMessage(`${message} Use external navigation as a fallback.`);
    } finally {
      this.loading = false;
    }
  }

  async submitFacilitySuggestion(): Promise<void> {
    if (this.suggestionSubmitting) return;
    const latitude = Number(this.suggestionDraft.latitude);
    const longitude = Number(this.suggestionDraft.longitude);
    if (!this.suggestionDraft.facilityName.trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      await this.showMessage('Enter a facility name and valid latitude/longitude coordinates.');
      return;
    }
    if (this.suggestionDraft.sourceUrl && !this.isHttpsUrl(this.suggestionDraft.sourceUrl)) {
      await this.showMessage('The source URL must use HTTPS.');
      return;
    }
    this.suggestionSubmitting = true;
    try {
      const id = await this.privateApi.submitFacilitySuggestion({
        facilityName: this.suggestionDraft.facilityName.trim(),
        facilityType: this.suggestionDraft.facilityType.trim(),
        latitude,
        longitude,
        ...(this.suggestionDraft.address.trim() ? { address: this.suggestionDraft.address.trim() } : {}),
        ...(this.suggestionDraft.contactNumber.trim() ? { contactNumber: this.suggestionDraft.contactNumber.trim() } : {}),
        ...(this.suggestionDraft.sourceUrl.trim() ? { sourceUrl: this.suggestionDraft.sourceUrl.trim() } : {})
      });
      this.suggestionDraft = {
        facilityName: '', facilityType: 'hospital', address: '', latitude: '',
        longitude: '', contactNumber: '', sourceUrl: ''
      };
      await this.showMessage(`Suggestion submitted for review. Reference: ${id}`);
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not submit the facility suggestion.');
    } finally {
      this.suggestionSubmitting = false;
    }
  }

  async useCurrentLocationForSuggestion(): Promise<void> {
    try {
      const coordinates = this.location ?? await this.locationService.getCurrentLocation();
      this.location = coordinates;
      this.suggestionDraft.latitude = String(coordinates.latitude);
      this.suggestionDraft.longitude = String(coordinates.longitude);
      await this.showMessage('Current coordinates added. Confirm they identify the facility location.');
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not read your location.');
    }
  }

  async openReports(forceRefresh = false): Promise<void> {
    this.activeTab = 'reports';
    if (!this.auth.currentUser) {
      this.reports = [];
      this.reportsDataLoaded = false;
      this.reportsOwnerEmail = null;
      return;
    }
    const userEmail = this.auth.currentUser.email;
    if (this.reportsOwnerEmail !== userEmail) {
      this.reports = [];
      this.reportsDataLoaded = false;
      this.reportsOwnerEmail = userEmail;
    }
    if (this.reportsDataLoaded && !forceRefresh) return;
    if (this.reportsLoading) return;
    this.reportsLoading = true;
    this.reportsError = '';
    try {
      this.reports = await this.withLoadTimeout(this.privateApi.getMyReports(), 'Loading your reports');
      this.reportsDataLoaded = true;
      this.reportsOwnerEmail = userEmail;
      if (!this.reports.length) this.reportsError = 'No reports have been saved to this account.';
    } catch (error) {
      this.reportsError = error instanceof Error ? error.message : 'Unable to load your reports.';
    } finally {
      this.reportsLoading = false;
    }
  }

  async openProfile(forceRefresh = false): Promise<void> {
    this.activeTab = 'profile';
    if (!this.auth.currentUser || !this.auth.isConfigured) return;
    const userEmail = this.auth.currentUser.email;
    if (this.profileOwnerEmail !== userEmail) {
      this.profileDataLoaded = false;
      this.profileOwnerEmail = userEmail;
    }
    if (this.profileDataLoaded && !forceRefresh) return;
    if (this.profileLoading) return;
    this.profileLoading = true;
    this.profileError = '';
    try {
      const profile = await this.withLoadTimeout(this.privateApi.getAccountProfile(), 'Loading your profile');
      this.profileDraft = {
        fullName: profile.fullName,
        phoneNumber: profile.phoneNumber,
        emergencyContactName: profile.emergencyContactName,
        emergencyContactNumber: profile.emergencyContactNumber
      };
      this.profileDataLoaded = true;
      this.profileOwnerEmail = userEmail;
    } catch (error) {
      this.profileError = error instanceof Error ? error.message : 'Unable to load your profile.';
    } finally {
      this.profileLoading = false;
    }
  }

  async saveProfile(): Promise<void> {
    if (this.profileSaving) return;
    this.profileSaving = true;
    this.profileError = '';
    try {
      await this.auth.updateProfile(this.profileDraft);
      this.profileDataLoaded = true;
      this.profileOwnerEmail = this.auth.currentUser?.email ?? null;
      await this.showMessage('Profile updated.');
    } catch (error) {
      this.profileError = error instanceof Error ? error.message : 'Unable to update your profile.';
    } finally {
      this.profileSaving = false;
    }
  }

  async authenticate(): Promise<void> {
    if (this.authenticating) return;
    this.authenticating = true;
    this.authError = '';
    this.authErrorCode = '';
    try {
      if (this.authMode === 'register') {
        if (!this.fullName.trim()) throw new Error('Enter your full name.');
        if (!this.privacyAccepted) throw new Error('Accept the privacy notice to create an account.');
        if (this.password !== this.confirmPassword) throw new Error('Passwords do not match.');
        if (this.password.length < 8) throw new Error('Use a password with at least 8 characters.');
        await this.auth.register({
          fullName: this.fullName.trim(),
          email: this.email.trim(),
          password: this.password,
          phoneNumber: this.phoneNumber.trim(),
          emergencyContactName: this.emergencyContactName.trim(),
          emergencyContactNumber: this.emergencyContactNumber.trim()
        });
      } else {
        await this.auth.login(this.email.trim(), this.password);
      }
      this.showAuth = false;
      this.guestMode = false;
      this.password = '';
      this.confirmPassword = '';
      this.activeTab = 'home';
      await this.showMessage(this.authMode === 'register' ? 'Account created. Welcome to ResQ-It.' : 'Signed in.');
    } catch (error) {
      this.authError = error instanceof Error ? error.message : 'Authentication failed.';
      this.authErrorCode = this.getAuthErrorCode(error);
    } finally {
      this.authenticating = false;
    }
  }

  async sendPasswordReset(): Promise<void> {
    if (this.sendingPasswordReset) return;
    const email = this.email.trim();
    if (!email) {
      await this.showMessage('Enter the account email address first.');
      return;
    }
    this.sendingPasswordReset = true;
    try {
      await this.auth.forgotPassword(email);
      await this.showMessage('If an account exists for that email, Firebase has sent a password reset email.');
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not request a password reset.');
    } finally {
      this.sendingPasswordReset = false;
    }
  }

  private getAuthErrorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return String(error.code);
    }
    return '';
  }

  async openAdmin(): Promise<void> {
    if (!this.isVerifiedAdmin) {
      await this.showMessage('Administrator access is not enabled for this account.');
      return;
    }
    this.activeTab = 'admin';
    this.adminSection = 'overview';
    await this.loadAdminData(false);
  }

  async refreshAdministratorAccess(): Promise<void> {
    this.refreshingAdminAccess = true;
    try {
      const isAdmin = await this.auth.refreshAdministratorAccess();
      if (!isAdmin) {
        await this.showMessage('Firebase still does not return the admin: true claim. Grant it with trusted Firebase Admin credentials, then refresh again.');
        return;
      }
      await this.showMessage('Administrator access verified.');
      if (this.activeTab === 'admin') await this.loadAdminData();
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not refresh administrator access.');
    } finally {
      this.refreshingAdminAccess = false;
    }
  }

  async copyAdminGrantCommand(): Promise<void> {
    const command = this.adminGrantCommand;
    try {
      await navigator.clipboard.writeText(command);
      await this.showMessage('Admin grant command copied.');
    } catch (error) {
      console.error('Could not copy the admin grant command.', error);
      await this.showMessage(`Copy this command from the account setup notice: ${command}`);
    }
  }

  async loadAdminData(forceRefresh = true): Promise<void> {
    if (!this.isVerifiedAdmin) {
      this.adminError = 'Administrator access is required to manage emergency information.';
      return;
    }
    if (this.adminDataLoaded && !forceRefresh) return;
    if (this.adminLoading) return;
    this.adminLoading = true;
    this.adminError = '';
    try {
      const results = await this.withLoadTimeout(Promise.allSettled([
        this.privateApi.getAdminDashboard(),
        this.privateApi.getAdminPrivateRecords(),
        this.firebase.getAdminFacilities(),
        this.firebase.getAdminLegacyFacilities()
      ]), 'Loading administrator records');
      const errors: string[] = [];
      const [dashboard, privateRecords, hotlineRecords, legacyRecords] = results;

      if (dashboard.status === 'fulfilled') {
        this.adminCategories = dashboard.value.categories;
        this.adminHotlines = dashboard.value.hotlines;
        this.adminHasMoreHotlines = dashboard.value.hasMoreHotlines;
        this.adminGuides = dashboard.value.guides;
      } else {
        errors.push(dashboard.reason instanceof Error
          ? `Categories, hotline summary, and guides could not be loaded: ${dashboard.reason.message}`
          : 'Categories, hotline summary, and guides could not be loaded.');
      }

      if (privateRecords.status === 'fulfilled') {
        this.adminSuggestions = privateRecords.value.suggestions;
        this.adminReports = privateRecords.value.reports;
      } else {
        errors.push(privateRecords.reason instanceof Error
          ? `Reports and facility suggestions could not be loaded: ${privateRecords.reason.message}`
          : 'Reports and facility suggestions could not be loaded.');
      }

      if (hotlineRecords.status === 'fulfilled') {
        this.adminFacilities = hotlineRecords.value;
        this.adminDataLoaded = true;
      } else {
        errors.push(hotlineRecords.reason instanceof Error
          ? `The emergencyHotlines directory could not be loaded: ${hotlineRecords.reason.message}`
          : 'The emergencyHotlines directory could not be loaded.');
      }

      if (legacyRecords.status === 'fulfilled') {
        this.adminLegacyFacilities = legacyRecords.value;
        this.adminLegacyFacilityCount = legacyRecords.value.length;
      } else {
        errors.push(legacyRecords.reason instanceof Error
          ? `Legacy emergencyFacilities records could not be loaded: ${legacyRecords.reason.message}`
          : 'Legacy emergencyFacilities records could not be loaded.');
      }
      this.adminError = errors.join(' ');
    } catch (error) {
      this.adminError = error instanceof Error ? error.message : 'Unable to load administrator data.';
    } finally {
      this.adminLoading = false;
    }
  }

  async loadMoreAdminDirectoryRecords(): Promise<void> {
    if (!this.isVerifiedAdmin || !this.adminHasMoreHotlines || this.adminLoading) return;
    this.adminLoading = true;
    this.adminError = '';
    try {
      const page = await this.firebase.getAdminHotlines();
      this.adminHotlines = [...this.adminHotlines, ...page.records];
      this.adminHasMoreHotlines = page.hasMore;
    } catch (error) {
      this.adminError = error instanceof Error ? error.message : 'Could not load more directory records.';
    } finally {
      this.adminLoading = false;
    }
  }

  async saveAdminCategory(): Promise<void> {
    if (this.adminSaving) return;
    const slug = this.categoryDraft.slug.trim().toLowerCase();
    if (!this.categoryDraft.name.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      await this.showMessage('Enter a category name and a valid lowercase slug.');
      return;
    }
    this.adminSaving = true;
    try {
      const { facilityTypesText, id: _id, ...category } = this.categoryDraft;
      await this.privateApi.saveAdminRecord('category', {
        ...category,
        name: category.name.trim(),
        slug,
        description: category.description.trim(),
        facilityTypes: facilityTypesText.split(',').map((part) => part.trim()).filter(Boolean)
      }, this.adminEditingType === 'category' ? this.adminEditingId ?? undefined : undefined);
      this.resetAdminDrafts();
      await this.loadAdminData();
      await this.showMessage('Category saved.');
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not save category.');
    } finally {
      this.adminSaving = false;
    }
  }

  async saveAdminHotline(statusChangeConfirmed = false): Promise<void> {
    if (this.adminSaving) return;
    const draft = this.hotlineDraft;
    if (!draft.name.trim()) {
      await this.showMessage('Enter the contact name.');
      return;
    }
    if (draft.officialSourceUrl.trim() && !this.isHttpsUrl(draft.officialSourceUrl.trim())) {
      await this.showMessage('A provided source URL must use HTTPS.');
      return;
    }
    if (draft.phoneVerified && !this.normalizePhone(draft.phoneNumber)) {
      await this.showMessage('A verified hotline number must be a valid phone number.');
      return;
    }
    if (draft.isCallable && (!draft.isActive || draft.verificationStatus !== 'verified' || !draft.phoneVerified)) {
      await this.showMessage('To mark this hotline reviewed for emergency use, activate it and verify its contact details and phone number first. Valid displayed numbers remain tappable.');
      return;
    }
    if (!statusChangeConfirmed) {
      const current = this.adminEditingType === 'hotline'
        ? this.adminHotlines.find((entry) => entry.id === this.adminEditingId)
        : undefined;
      const statusChanged = current
        ? current.isActive !== draft.isActive
          || current.verificationStatus !== draft.verificationStatus
          || current.phoneVerified !== draft.phoneVerified
          || current.isCallable !== draft.isCallable
        : draft.isActive || draft.verificationStatus === 'verified' || draft.phoneVerified || draft.isCallable;
      if (statusChanged) {
        const confirmed = await this.confirmAdminStatusChange(
          'Confirm hotline status change',
          'Changing verification or activation affects whether this hotline and its phone number are shown publicly.'
        );
        if (!confirmed) return;
        await this.saveAdminHotline(true);
        return;
      }
    }
    this.adminSaving = true;
    try {
      await this.privateApi.saveAdminRecord('hotline', {
        ...draft,
        phoneVerified: draft.phoneVerified === true,
        name: draft.name.trim(),
        phoneNumber: draft.phoneNumber.trim(),
        countryCode: draft.countryCode.trim(),
        region: draft.region.trim(),
        description: draft.description.trim(),
        officialSourceUrl: draft.officialSourceUrl.trim()
      }, this.adminEditingType === 'hotline' ? this.adminEditingId ?? undefined : undefined);
      this.invalidatePublicHotlineView();
      this.resetAdminDrafts();
      await this.loadAdminData();
      await this.showMessage('Hotline saved.');
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not save hotline.');
    } finally {
      this.adminSaving = false;
    }
  }

  async saveAdminFacility(statusChangeConfirmed = false): Promise<void> {
    if (this.adminSaving) return;
    if (!this.isVerifiedAdmin) {
      await this.showMessage('Only the verified administrator can edit emergency facility information.');
      return;
    }
    const draft = this.facilityDraft;
    const { id, alternativePhoneText, ...facilityFields } = draft;
    if (!draft.name.trim() || !draft.municipality.trim()) {
      await this.showMessage('Enter the facility name and municipality.');
      return;
    }
    const hasAnyCoordinate = draft.latitude !== undefined || draft.longitude !== undefined;
    const hasValidCoordinates = typeof draft.latitude === 'number'
      && Number.isFinite(draft.latitude) && draft.latitude >= -90 && draft.latitude <= 90
      && typeof draft.longitude === 'number'
      && Number.isFinite(draft.longitude) && draft.longitude >= -180 && draft.longitude <= 180;
    if (hasAnyCoordinate && !hasValidCoordinates) {
      await this.showMessage('Enter both valid coordinates or leave both blank.');
      return;
    }
    const sourceUrl = draft.sourceUrl || draft.officialSourceUrl;
    if (sourceUrl && !this.isHttpsUrl(sourceUrl)) {
      await this.showMessage('A provided source URL must use HTTPS.');
      return;
    }
    if (draft.phoneVerified && (!draft.phone.trim() || !this.normalizePhone(draft.phone))) {
      await this.showMessage('A verified phone number must be a valid phone number.');
      return;
    }
    const alternativePhones = alternativePhoneText
      .split(/[|;]/)
      .map((phone) => phone.trim())
      .filter(Boolean);
    if (alternativePhones.length > 5 || alternativePhones.some((phone) => phone.length > 40)) {
      await this.showMessage('Enter up to 5 alternative phone numbers, each no longer than 40 characters, separated by |.');
      return;
    }
    if (draft.isCallable && (!draft.isActive || draft.verificationStatus !== 'verified' || !draft.phoneVerified)) {
      await this.showMessage('To mark this facility reviewed for emergency use, activate it and verify its contact details and phone number first. Valid displayed numbers remain tappable.');
      return;
    }
    if ((draft.facebookUrl && !this.isHttpsUrl(draft.facebookUrl))
      || (draft.websiteUrl && !this.isHttpsUrl(draft.websiteUrl))) {
      await this.showMessage('Facebook and website links must use HTTPS.');
      return;
    }

    if (!statusChangeConfirmed) {
      const current = this.adminEditingType === 'facility'
        ? this.adminFacilities.find((entry) => entry.id === this.adminEditingId)
        : undefined;
      const statusChanged = current
        ? current.isActive !== draft.isActive
          || current.verificationStatus !== draft.verificationStatus
          || current.isPublic !== draft.isPublic
          || current.phoneVerified !== draft.phoneVerified
          || current.isCallable !== draft.isCallable
        : draft.isActive
          || draft.verificationStatus === 'verified'
          || draft.isPublic
          || draft.phoneVerified
          || draft.isCallable;
      if (statusChanged) {
        const confirmed = await this.confirmAdminStatusChange(
          'Confirm facility status change',
          'Changing public visibility, verification, or activation affects whether this contact is shown or enabled.'
        );
        if (!confirmed) return;
        await this.saveAdminFacility(true);
        return;
      }
    }

    this.adminSaving = true;
    try {
      await this.firebase.saveFacility({
        ...facilityFields,
        alternativePhone: alternativePhones,
        name: facilityFields.name.trim(),
        type: facilityFields.type.trim() || facilityFields.category,
        address: facilityFields.address.trim(),
        barangay: facilityFields.barangay.trim(),
        municipality: facilityFields.municipality.trim(),
        region: facilityFields.region.trim(),
        phone: facilityFields.phone.trim(),
        email: facilityFields.email.trim(),
        facebook: facilityFields.facebook.trim() || facilityFields.facebookUrl.trim(),
        facebookUrl: facilityFields.facebook.trim() || facilityFields.facebookUrl.trim(),
        website: facilityFields.website.trim() || facilityFields.websiteUrl.trim(),
        websiteUrl: facilityFields.website.trim() || facilityFields.websiteUrl.trim(),
        sourceUrl: facilityFields.sourceUrl.trim() || facilityFields.officialSourceUrl.trim(),
        officialSourceUrl: facilityFields.sourceUrl.trim() || facilityFields.officialSourceUrl.trim(),
        openingHours: facilityFields.openingHours.trim(),
        description: facilityFields.description.trim(),
        locationVerified: hasValidCoordinates && facilityFields.locationVerified === true,
        isCallable: facilityFields.isCallable === true,
        isPublic: facilityFields.isPublic === true,
        phoneVerified: facilityFields.phoneVerified === true
      }, this.adminEditingType === 'facility' ? id || undefined : undefined);
      this.facilityService.invalidate();
      this.invalidatePublicHotlineView();
      this.adminEditingId = null;
      this.adminEditingType = null;
      this.facilityDraft = this.newFacilityDraft();
      await this.loadAdminData();
      await this.showMessage('Emergency facility saved.');
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not save the facility.');
    } finally {
      this.adminSaving = false;
    }
  }

  async findFacilityCoordinates(): Promise<void> {
    const draft = this.facilityDraft;
    if (!draft.name.trim() || !draft.address.trim() || !draft.municipality.trim()) {
      await this.showMessage('Enter the facility name, complete address, and municipality first.');
      return;
    }

    this.facilityCoordinatesLoading = true;
    try {
      const query = `${draft.name}, ${draft.address}, ${draft.municipality}, Oriental Mindoro, Philippines`;
      const result = await this.geocode(query);
      if (!result) throw new Error('No matching facility location was found. Check the name and address.');
      const latitude = Number(result.lat);
      const longitude = Number(result.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude === 0 || longitude === 0) {
        throw new Error('The place search returned invalid coordinates. Enter the coordinates manually.');
      }
      this.facilityDraft = { ...draft, latitude, longitude };
      await this.showMessage(`Coordinates found: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}. Verify the location before saving.`);
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not find facility coordinates.');
    } finally {
      this.facilityCoordinatesLoading = false;
    }
  }

  editFacility(id: string): void {
    const facility = this.adminFacilities.find((entry) => entry.id === id);
    if (!facility) return;
    this.adminEditingId = id;
    this.adminEditingType = 'facility';
    this.facilityDraft = {
      ...this.newFacilityDraft(),
      ...facility,
      category: facility.category ?? 'other',
      phone: facility.phone ?? '',
      address: facility.address ?? '',
      barangay: facility.barangay ?? '',
      alternativePhoneText: facility.alternativePhone?.join(' | ') ?? '',
      municipality: facility.municipality ?? '',
      region: facility.region ?? '',
      email: facility.email ?? '',
      facebook: facility.facebook ?? facility.facebookUrl ?? '',
      facebookUrl: facility.facebookUrl ?? facility.facebook ?? '',
      website: facility.website ?? facility.websiteUrl ?? '',
      websiteUrl: facility.websiteUrl ?? facility.website ?? '',
      openingHours: facility.openingHours ?? '',
      sourceUrl: facility.sourceUrl ?? facility.officialSourceUrl ?? '',
      officialSourceUrl: facility.officialSourceUrl ?? facility.sourceUrl ?? '',
      description: facility.description ?? '',
      verificationStatus: facility.verificationStatus ?? 'unverified',
      isActive: facility.isActive === true,
      phoneVerified: facility.phoneVerified === true,
      locationVerified: facility.locationVerified === true,
      isPublic: facility.isPublic === true,
      isCallable: facility.isCallable === true
    };
  }

  async toggleHotlineActive(facility: Facility): Promise<void> {
    await this.updateHotlineReviewFlags(facility, { isActive: !facility.isActive });
  }

  async verifyHotline(facility: Facility): Promise<void> {
    const confirmed = await this.confirmAdminStatusChange(
      'Verify this emergency contact?',
      'Only verify this record after checking its details against a reliable source. This does not activate the record or verify its phone number.'
    );
    if (confirmed) {
      await this.updateHotlineReviewFlags(facility, { verificationStatus: 'verified' });
    }
  }

  async verifyHotlinePhone(facility: Facility): Promise<void> {
    const phone = facility.phone?.trim();
    if (!phone || !this.normalizePhone(phone)) {
      await this.showMessage('Add a valid phone number before verifying it.');
      return;
    }
    const confirmed = await this.confirmAdminStatusChange(
      'Verify this phone number?',
      'Confirm that you checked this number against a reliable source. Verification will not activate or publish the record by itself.'
    );
    if (confirmed) await this.updateHotlineReviewFlags(facility, { phoneVerified: true });
  }

  async verifyHotlineLocation(facility: Facility): Promise<void> {
    if (!this.facilityHasCoordinates(facility)) {
      await this.showMessage('Valid latitude and longitude are required to verify a location.');
      return;
    }
    const confirmed = await this.confirmAdminStatusChange(
      'Verify this location?',
      'Confirm that the coordinates match the facility location. This does not activate the record.'
    );
    if (confirmed) await this.updateHotlineReviewFlags(facility, { locationVerified: true });
  }

  private async updateHotlineReviewFlags(
    facility: Facility,
    changes: Parameters<FirebaseService['updateHotlineFlags']>[1]
  ): Promise<void> {
    if (!this.isVerifiedAdmin || this.adminSaving) return;
    this.adminSaving = true;
    try {
      await this.firebase.updateHotlineFlags(facility.id, changes);
      this.facilityService.invalidate();
      this.invalidatePublicHotlineView();
      await this.loadAdminData();
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not update the emergency hotline.');
    } finally {
      this.adminSaving = false;
    }
  }

  async deleteFacility(id: string): Promise<void> {
    if (!this.isVerifiedAdmin) {
      await this.showMessage('Only the verified administrator can delete emergency facility information.');
      return;
    }
    const alert = await this.alertController.create({
      header: 'Delete this facility?',
      message: 'It will be removed from nearby results.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => { void this.performFacilityDelete(id); } }
      ]
    });
    await alert.present();
  }

  downloadFacilityCsvTemplate(): void {
    const blob = new Blob([facilityCsvTemplate()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'resq-it-facilities-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  async previewFacilityCsv(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    this.facilityCsvRows = [];
    this.facilityCsvImportMessage = '';
    this.facilityCsvImportError = '';
    this.facilityCsvImportProgress = 0;
    if (!file) return;
    if (!this.isVerifiedAdmin) {
      this.facilityCsvImportError = 'Verified administrator access is required.';
      input.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      this.facilityCsvImportError = 'CSV file must be 5 MB or smaller.';
      input.value = '';
      return;
    }
    try {
      const rows = parseFacilityCsv(await file.text());
      const directoryFacilities = await this.firebase.getAdminFacilities();
      const existing = new Map(directoryFacilities.map((facility) => [
        facilityDuplicateKey(
          facility.name,
          String(facility.category ?? facility.type),
          facility.municipality ?? ''
        ),
        facility
      ]));
      for (const row of rows) {
        const duplicate = existing.get(row.duplicateKey);
        if (duplicate && !row.duplicateType) {
          row.duplicateType = 'existing';
          row.duplicateOfId = duplicate.id;
        }
      }
      this.facilityCsvRows = rows;
      this.facilityCsvUpdateDuplicates = false;
    } catch (error) {
      this.facilityCsvImportError = error instanceof Error ? error.message : 'Could not read the CSV.';
    } finally {
      input.value = '';
    }
  }

  async importFacilityCsv(): Promise<void> {
    if (!this.isVerifiedAdmin || this.facilityCsvImporting) return;
    const importRows = this.facilityCsvRows.filter((row) =>
      row.errors.length === 0
      && row.duplicateType !== 'csv'
      && (row.duplicateType !== 'existing' || this.facilityCsvUpdateDuplicates)
      && !row.imported
      && !row.updated
      && !row.skipped
    );
    if (!importRows.length) {
      this.facilityCsvImportError = 'There are no valid rows selected for import. Resolve or skip duplicate rows first.';
      return;
    }
    this.facilityCsvImporting = true;
    this.facilityCsvImportError = '';
    this.facilityCsvImportProgress = 0;
    try {
      const result = await this.firebase.importFacilities(importRows.map((row) => ({
        line: row.line,
        facility: row.facility
      })), this.facilityCsvUpdateDuplicates, (progress) => {
        this.facilityCsvImportProgress = progress;
      });
      this.facilityCsvImportProgress = 100;
      for (const row of importRows) {
        const failure = result.failed.find((item) => item.line === row.line);
        if (failure) row.importError = failure.error;
        else if (result.importedLines.includes(row.line)) row.imported = true;
        else if (result.updatedLines.includes(row.line)) row.updated = true;
        else if (result.skippedLines.includes(row.line)) {
          row.skipped = true;
          row.importError = 'Skipped because an existing verified record must be preserved or the duplicate policy is set to skip.';
        }
      }

      this.facilityService.invalidate();
      this.invalidatePublicHotlineView();
      await this.loadAdminData();
      this.facilityCsvImportMessage =
        `CSV rows: ${this.facilityCsvRows.length}; valid: ${this.facilityCsvValidCount}; `
        + `invalid: ${this.facilityCsvInvalidCount}; duplicates: ${this.facilityCsvDuplicateCount}; `
        + `imported: ${result.imported}; updated: ${result.updated}; skipped: ${result.skipped}; `
        + `failed: ${result.failed.length}.`;
      if (result.failed.length) {
        this.facilityCsvImportError = result.failed
          .map((item) => `Row ${item.line}: ${item.error}`)
          .join('\n');
      }
    } catch (error) {
      this.facilityCsvImportError = error instanceof Error ? error.message : 'Facility import failed.';
    } finally {
      this.facilityCsvImporting = false;
    }
  }

  async migrateFacilitiesToHotlines(): Promise<void> {
    if (!this.isVerifiedAdmin || this.facilityMigrationInProgress) return;
    const confirmed = await this.confirmAdminStatusChange(
      'Migrate Existing Emergency Records',
      'Copy records from emergencyFacilities into emergencyHotlines. Existing destination records, including verified records, will not be overwritten. The original collection will remain untouched as a backup. Existing active and verified status is preserved, so eligible records may appear in the public directory.'
    );
    if (!confirmed) return;

    this.facilityMigrationInProgress = true;
    this.facilityMigrationError = '';
    this.facilityMigrationResult = null;
    this.facilityMigrationProgress = {
      total: 0,
      processed: 0,
      migrated: 0,
      skipped: 0,
      failed: 0
    };
    try {
      const result = await this.firebase.migrateFacilitiesToHotlines((progress) => {
        this.facilityMigrationProgress = progress;
      });
      this.facilityMigrationResult = result;
      this.facilityService.invalidate();
      this.invalidatePublicHotlineView();
      await this.loadAdminData();
      if (result.failed.length) {
        this.facilityMigrationError = result.failed
          .map((item) => `${item.facilityId}: ${item.error}`)
          .join('\n');
      }
    } catch (error) {
      this.facilityMigrationError = error instanceof Error ? error.message : 'Facility migration failed.';
    } finally {
      this.facilityMigrationInProgress = false;
    }
  }

  openAdminHotlinesForMigration(): void {
    this.adminSection = 'hotlines';
  }

  isLegacyFacilityMigrated(facility: Facility): boolean {
    return this.findCanonicalFacilityForLegacy(facility) !== undefined;
  }

  async editLegacyFacility(facility: Facility): Promise<void> {
    if (!this.isVerifiedAdmin || this.facilityMigrationInProgress || this.adminLoading) return;
    const existing = this.findCanonicalFacilityForLegacy(facility);
    if (existing) {
      this.editFacility(existing.id);
      return;
    }

    const confirmed = await this.confirmAdminStatusChange(
      'Copy legacy contact to editable Hotlines?',
      'This copies the selected emergencyFacilities record into emergencyHotlines. The original Firebase document stays unchanged. The new copy will appear in the editable Hotlines list.'
    );
    if (!confirmed) return;

    this.facilityMigrationInProgress = true;
    this.facilityMigrationError = '';
    try {
      const result = await this.firebase.migrateFacilitiesToHotlines(undefined, [facility.id]);
      if (result.failed.length) {
        throw new Error(result.failed.map((item) => item.error).join(' '));
      }
      this.facilityService.invalidate();
      this.invalidatePublicHotlineView();
      await this.loadAdminData();

      const migrated = this.findCanonicalFacilityForLegacy(facility);
      if (!migrated) {
        const reason = result.skippedRecords[0]?.reason;
        throw new Error(reason
          ? `This contact was not copied: ${reason} Find and edit the matching record in Hotlines.`
          : 'The contact was not copied to emergencyHotlines. Refresh the directory and try again.');
      }
      this.editFacility(migrated.id);
      await this.showMessage('Contact copied to Hotlines. The original Firebase record remains unchanged. Edit the form and save your changes.');
    } catch (error) {
      this.facilityMigrationError = error instanceof Error ? error.message : 'Could not copy the legacy contact.';
      await this.showMessage(this.facilityMigrationError);
    } finally {
      this.facilityMigrationInProgress = false;
    }
  }

  private findCanonicalFacilityForLegacy(facility: Facility): Facility | undefined {
    return this.adminFacilities.find((record) => record.legacyFacilityId === facility.id)
      ?? this.adminFacilities.find((record) =>
        facilityDuplicateKey(
          record.name,
          String(record.category ?? record.type),
          record.municipality ?? record.region ?? ''
        ) === facilityDuplicateKey(
          facility.name,
          String(facility.category ?? facility.type),
          facility.municipality ?? facility.region ?? ''
        )
      );
  }

  private async performFacilityDelete(id: string): Promise<void> {
    try {
      const facility = this.adminFacilities.find((entry) => entry.id === id);
      await this.firebase.deleteFacility(id);
      if (facility) {
        this.facilityService.invalidate();
        this.invalidatePublicHotlineView();
      }
      await this.loadAdminData();
      await this.showMessage('Facility deleted.');
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not delete the facility.');
    }
  }

  private isHttpsUrl(value: string): boolean {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }

  private invalidatePublicHotlineView(): void {
    this.hotlines = [];
    this.hotlinesDataLoaded = false;
    this.hotlinesStale = false;
    this.hotlinesError = '';
  }

  private matchesFacilityFilters(
    facility: Facility,
    verificationStatus: string,
    isActive: boolean
  ): boolean {
    const search = this.adminDebouncedFacilitySearch.trim().toLocaleLowerCase();
    const matchesSearch = !search || [
      facility.name, facility.type, facility.address, facility.municipality,
      facility.barangay, facility.phone, facility.alternativePhone?.join(' ')
    ].some((value) => value?.toLocaleLowerCase().includes(search));
    const matchesMunicipality = this.adminFacilityMunicipalityFilter === 'all'
      || facility.municipality === this.adminFacilityMunicipalityFilter;
    const matchesCategory = this.adminFacilityCategoryFilter === 'all'
      || facility.category === this.adminFacilityCategoryFilter;
    const matchesVerification = this.adminFacilityVerificationFilter === 'all'
      || (this.adminFacilityVerificationFilter === 'verified' && verificationStatus === 'verified')
      || (this.adminFacilityVerificationFilter === 'unverified' && verificationStatus !== 'verified');
    const matchesActive = this.adminFacilityActiveFilter === 'all'
      || (this.adminFacilityActiveFilter === 'active' && isActive)
      || (this.adminFacilityActiveFilter === 'inactive' && !isActive);
    return matchesSearch && matchesMunicipality && matchesCategory && matchesVerification && matchesActive;
  }

  async importHotlineCsv(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    this.hotlineCsvImportMessage = '';
    this.hotlineCsvImportError = '';
    if (!file) return;
    if (!this.isVerifiedAdmin) {
      this.hotlineCsvImportError = 'Administrator access is required to import contacts.';
      input.value = '';
      return;
    }
    if (file.size > 1024 * 1024) {
      this.hotlineCsvImportError = 'CSV file must be 1 MB or smaller.';
      input.value = '';
      return;
    }

    this.hotlineCsvImporting = true;
    try {
      const entries = parseHotlineCsv(await file.text());
      const result = await this.firebase.importHotlines(entries.map((entry, index) => ({
        line: index + 2,
        facility: {
          name: entry.name,
          type: entry.category,
          category: entry.category,
          municipality: '',
          countryCode: entry.countryCode,
          region: entry.region,
          phone: entry.phoneNumber,
          description: entry.description,
          sourceUrl: entry.officialSourceUrl,
          officialSourceUrl: entry.officialSourceUrl,
          verificationStatus: 'unverified' as const,
          isActive: false,
          phoneVerified: false,
          locationVerified: false,
          isCallable: false
        }
      })));
      if (result.imported) this.invalidatePublicHotlineView();
      await this.loadAdminData();
      this.hotlineCsvImportMessage =
        `${entries.length} rows processed; ${result.imported} imported; ${result.skipped} duplicates skipped; `
        + `${result.failed.length} failed. Imported records remain unverified and inactive.`;
      if (result.failed.length) {
        this.hotlineCsvImportError = result.failed.map((item) => `Row ${item.line}: ${item.error}`).join('\n');
      }
    } catch (error) {
      this.hotlineCsvImportError = error instanceof Error ? error.message : 'Could not import the CSV file.';
    } finally {
      this.hotlineCsvImporting = false;
      input.value = '';
    }
  }

  async saveAdminGuide(): Promise<void> {
    if (this.adminSaving) return;
    const draft = this.guideDraft;
    if (!draft.title.trim() || !draft.summary.trim() || !draft.instructions.trim() || !draft.sourceUrl.trim()) {
      await this.showMessage('Complete the guide title, summary, instructions, and official source.');
      return;
    }
    this.adminSaving = true;
    try {
      await this.privateApi.saveAdminRecord('guide', {
        ...draft,
        title: draft.title.trim(),
        summary: draft.summary.trim(),
        instructions: draft.instructions.trim(),
        sourceUrl: draft.sourceUrl.trim()
      }, this.adminEditingType === 'guide' ? this.adminEditingId ?? undefined : undefined);
      this.resetAdminDrafts();
      await this.loadAdminData();
      await this.showMessage('Guide saved.');
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not save guide.');
    } finally {
      this.adminSaving = false;
    }
  }

  private async confirmAdminStatusChange(header: string, message: string): Promise<boolean> {
    const alert = await this.alertController.create({
      header,
      message,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Confirm', role: 'confirm' }
      ]
    });
    const dismissal = alert.onDidDismiss();
    await alert.present();
    const result = await dismissal;
    return result.role === 'confirm';
  }

  editAdminRecord(type: 'category' | 'hotline' | 'guide', id: string): void {
    this.adminEditingId = id;
    this.adminEditingType = type;
    if (type === 'category') {
      const value = this.adminCategories.find((item) => item.id === id);
      if (value) this.categoryDraft = { ...value, facilityTypesText: value.facilityTypes.join(', ') };
    } else if (type === 'hotline') {
      const item = this.adminHotlines.find((record) => record.id === id);
      if (!item) return;
      const { id: _id, lastVerifiedAt: _verified, ...value } = item;
      this.hotlineDraft = { ...this.newHotlineDraft(), ...value };
    } else {
      const item = this.adminGuides.find((record) => record.id === id);
      if (!item) return;
      const { id: _id, ...value } = item;
      this.guideDraft = { ...this.newGuideDraft(), ...value };
    }
    this.adminSection = type === 'category' ? 'categories' : type === 'hotline' ? 'hotlines' : 'guides';
  }

  async deleteAdminRecord(type: 'emergencyCategories' | 'emergencyHotlines' | 'emergencyGuides', id: string): Promise<void> {
    const alert = await this.alertController.create({
      header: 'Delete this record?',
      message: 'This action cannot be undone.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => { void this.performAdminDelete(type, id); } }
      ]
    });
    await alert.present();
  }

  async reviewSuggestion(item: FacilitySuggestion, status: 'approved' | 'rejected'): Promise<void> {
    try {
      await this.privateApi.reviewFacilitySuggestion(item.id, status, this.suggestionReviewNote);
      this.suggestionReviewNote = '';
      await this.loadAdminData();
      await this.showMessage(`Suggestion ${status}.`);
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not review suggestion.');
    }
  }

  async approveSuggestionAsDraft(item: FacilitySuggestion): Promise<void> {
    if (!this.isVerifiedAdmin) {
      await this.showMessage('Only the verified administrator can review facility suggestions.');
      return;
    }
    try {
      await this.privateApi.reviewFacilitySuggestion(item.id, 'approved', this.suggestionReviewNote);
      const address = item.address?.trim() ?? '';
      const municipality = this.municipalityNames.find((name) =>
        address.toLocaleLowerCase().includes(name.toLocaleLowerCase())
      ) ?? '';
      const facilityType = item.facilityType.trim() || 'other';
      const type = facilityType.toLocaleLowerCase();
      const category: EmergencyCategory = /hospital|clinic|medical|health|pharmacy/.test(type)
        ? 'medical'
        : /fire/.test(type)
          ? 'fire'
          : /police/.test(type)
            ? 'police'
            : /rescue|ambulance|accident/.test(type)
              ? 'accident'
              : 'other';
      this.facilityDraft = {
        ...this.newFacilityDraft(),
        name: item.facilityName.trim(),
        type: facilityType,
        category,
        latitude: item.latitude,
        longitude: item.longitude,
        address,
        municipality,
        phone: item.contactNumber?.trim() ?? '',
        officialSourceUrl: item.sourceUrl && this.isHttpsUrl(item.sourceUrl) ? item.sourceUrl : ''
      };
      this.suggestionReviewNote = '';
      this.adminEditingId = null;
      this.adminEditingType = null;
      this.adminSection = 'hotlines';
      await this.loadAdminData();
      await this.showMessage('Suggestion approved. Review the facility draft, complete missing details, and save it as inactive and unverified.');
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not prepare facility draft.');
    }
  }

  async setAdminReportStatus(
    reportId: string,
    event: Event,
    sourceCollection: EmergencyReport['sourceCollection']
  ): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const status = select.value as EmergencyReport['status'];
    const report = this.adminReports.find((item) => item.reportId === reportId);
    if (report && report.status !== status) {
      const confirmed = await this.confirmAdminStatusChange(
        'Confirm report status change',
        'This updates the status of the report stored in ResQ-It. It does not notify or dispatch emergency responders.'
      );
      if (!confirmed) {
        select.value = report.status;
        return;
      }
    }
    if (this.adminSaving) {
      if (report) select.value = report.status;
      return;
    }
    this.adminSaving = true;
    try {
      await this.privateApi.updateReportStatus(reportId, status, sourceCollection);
      await this.loadAdminData();
      await this.showMessage('Report status updated. This is an app record only.');
    } catch (error) {
      if (report) select.value = report.status;
      await this.showMessage(error instanceof Error ? error.message : 'Could not update report status.');
    } finally {
      this.adminSaving = false;
    }
  }

  cancelAdminEdit(): void {
    this.resetAdminDrafts();
  }

  private async performAdminDelete(type: 'emergencyCategories' | 'emergencyHotlines' | 'emergencyGuides', id: string): Promise<void> {
    try {
      const contentType = type === 'emergencyCategories' ? 'category' : type === 'emergencyHotlines' ? 'hotline' : 'guide';
      await this.privateApi.deleteAdminRecord(contentType, id);
      if (type === 'emergencyHotlines') this.invalidatePublicHotlineView();
      await this.loadAdminData();
      await this.showMessage('Record deleted.');
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not delete record.');
    }
  }

  private resetAdminDrafts(): void {
    this.adminEditingId = null;
    this.adminEditingType = null;
    this.categoryDraft = this.newCategoryDraft();
    this.facilityDraft = this.newFacilityDraft();
    this.hotlineDraft = this.newHotlineDraft();
    this.guideDraft = this.newGuideDraft();
  }

  private newCategoryDraft(): EmergencyCategoryRecord & { facilityTypesText: string } {
    return { id: '', name: '', slug: '', description: '', icon: 'alert-circle-outline', facilityTypes: [], facilityTypesText: '', isActive: true, displayOrder: 0 };
  }

  private newFacilityDraft(): FacilityDraft {
    return {
      id: '',
      name: '',
      type: 'hospital',
      category: 'medical',
      latitude: undefined,
      longitude: undefined,
      address: '',
      barangay: '',
      municipality: '',
      region: '',
      phone: '',
      alternativePhoneText: '',
      email: '',
      facebook: '',
      facebookUrl: '',
      website: '',
      websiteUrl: '',
      openingHours: '',
      sourceUrl: '',
      officialSourceUrl: '',
      description: '',
      phoneVerified: false,
      locationVerified: false,
      isCallable: false,
      isPublic: false,
      verificationStatus: 'unverified',
      isActive: false
    };
  }

  private newHotlineDraft(): Omit<Hotline, 'id' | 'lastVerifiedAt'> {
    return { name: '', phoneNumber: '', phoneVerified: false, isCallable: false, countryCode: 'PH', region: 'Oriental Mindoro', category: 'other', description: '', officialSourceUrl: '', verificationStatus: 'unverified', isActive: false };
  }

  private newGuideDraft(): Omit<EmergencyGuide, 'id'> {
    return { title: '', category: 'medical', summary: '', instructions: '', sourceUrl: '', reviewedBy: '', isPublished: false };
  }

  async updatePassword(): Promise<void> {
    if (this.newPassword !== this.confirmNewPassword) {
      await this.showMessage('New passwords do not match.');
      return;
    }
    if (this.newPassword.length < 8) {
      await this.showMessage('Use a new password with at least 8 characters.');
      return;
    }
    try {
      await this.auth.changePassword(this.currentPassword, this.newPassword);
      this.currentPassword = '';
      this.newPassword = '';
      this.confirmNewPassword = '';
      this.activeTab = 'home';
      await this.showMessage('Password changed. Sign in again with your new password.');
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Could not change your password.');
    }
  }

  async signOut(): Promise<void> {
    try {
      await this.auth.signOut();
      this.guestMode = false;
      await this.showMessage('You have signed out.');
    } catch (error) {
      await this.showMessage(error instanceof Error ? error.message : 'Sign out failed.');
    }
  }

  async submitReport(): Promise<void> {
    if (this.reportSubmitting) return;
    if (!this.auth.currentUser) {
      this.showAuth = true;
      this.activeTab = 'profile';
      await this.showMessage('Sign in to save a private report.');
      return;
    }
    const alert = await this.alertController.create({
      header: 'Save an emergency report?',
      message: 'This saves a private record in your ResQ-It account. It does not contact emergency services. If you are in immediate danger, contact the appropriate official service directly.',
      inputs: [{ name: 'description', type: 'textarea', placeholder: 'Briefly describe the situation (optional)' }],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Save report',
          handler: async (values: { description?: string }) => {
            if (this.reportSubmitting) return false;
            this.reportSubmitting = true;
            try {
              const id = await this.privateApi.submitReport({
                category: this.activeCategory,
                ...(values.description?.trim() ? { description: values.description.trim() } : {}),
                ...(this.location ? {
                  latitude: this.location.latitude,
                  longitude: this.location.longitude
                } : {})
              });
              this.reportsDataLoaded = false;
              await this.showMessage(`Report saved. Reference: ${id}`);
            } catch (error) {
              await this.showMessage(error instanceof Error ? error.message : 'Could not save the report.');
            } finally {
              this.reportSubmitting = false;
            }
            return true;
          }
        }
      ]
    });
    await alert.present();
  }

  async showMessage(message: string): Promise<void> {
    const toast = await this.toastController.create({ message, duration: 3500, position: 'bottom' });
    await toast.present();
  }

  onHotlineSearchChange(value: string): void {
    this.hotlineSearchText = value;
    if (this.hotlineSearchTimer !== undefined) window.clearTimeout(this.hotlineSearchTimer);
    this.hotlineSearchTimer = window.setTimeout(() => {
      this.debouncedHotlineSearchText = value;
    }, 180);
  }

  onAdminHotlineSearchChange(value: string): void {
    this.adminHotlineSearch = value;
    if (this.adminHotlineSearchTimer !== undefined) window.clearTimeout(this.adminHotlineSearchTimer);
    this.adminHotlineSearchTimer = window.setTimeout(() => {
      this.adminDebouncedHotlineSearch = value;
    }, 180);
  }

  onAdminFacilitySearchChange(value: string): void {
    this.adminFacilitySearch = value;
    if (this.adminFacilitySearchTimer !== undefined) window.clearTimeout(this.adminFacilitySearchTimer);
    this.adminFacilitySearchTimer = window.setTimeout(() => {
      this.adminDebouncedFacilitySearch = value;
    }, 180);
  }

  async retryCurrentPage(): Promise<void> {
    if (!this.isOnline) {
      await this.showMessage('You are offline. Check your connection and try again.');
      return;
    }
    if (this.activeTab === 'map') await this.findFacilities();
    else if (this.activeTab === 'hotlines') await this.openHotlines(true);
    else if (this.activeTab === 'guides') await this.openGuides(true);
    else if (this.activeTab === 'reports') await this.openReports(true);
    else if (this.activeTab === 'profile') await this.openProfile(true);
    else if (this.activeTab === 'admin') await this.loadAdminData(true);
    else if (!this.auth.currentUser) await this.auth.initialize();
  }

  verifiedFacilityContactLink(facility: Facility, channel: 'facebook' | 'website'): string | null {
    const verified = channel === 'facebook' ? facility.facebookVerified : facility.websiteVerified;
    const value = channel === 'facebook'
      ? facility.facebookUrl ?? facility.facebook
      : facility.websiteUrl ?? facility.website;
    if (!value || (!this.isDirectoryTestingMode
      && (facility.isActive !== true || facility.verificationStatus !== 'verified' || !verified))) return null;
    try {
      return new URL(value).protocol === 'https:' ? value : null;
    } catch {
      return null;
    }
  }

  verifiedFacilityEmailLink(facility: Facility): string | null {
    const email = facility.email?.trim();
    return (this.isDirectoryTestingMode || (
      facility.isActive === true
      && facility.verificationStatus === 'verified'
      && facility.emailVerified === true
    ))
      && email
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ? `mailto:${email}`
      : null;
  }

  verifiedHotlineContactLink(hotline: Hotline, channel: 'facebook' | 'website'): string | null {
    const verified = channel === 'facebook' ? hotline.facebookVerified : hotline.websiteVerified;
    const value = channel === 'facebook' ? hotline.facebook : hotline.website;
    if (!value || (!this.isDirectoryTestingMode
      && (hotline.verificationStatus !== 'verified' || !hotline.isActive || !verified))) return null;
    try {
      return new URL(value).protocol === 'https:' ? value : null;
    } catch {
      return null;
    }
  }

  verifiedHotlineEmailLink(hotline: Hotline): string | null {
    const email = hotline.email?.trim();
    return (this.isDirectoryTestingMode || (
      hotline.verificationStatus === 'verified'
      && hotline.isActive
      && hotline.emailVerified === true
    ))
      && email
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ? `mailto:${email}`
      : null;
  }

  private playIntro(): void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.documentElement.classList.add('show-intro');
    window.setTimeout(() => document.documentElement.classList.remove('show-intro'), 1650);
  }

  private async renderMap(): Promise<void> {
    const container = document.getElementById('facility-map');
    const firstMappedFacility = this.facilities.find((facility) => this.facilityHasCoordinates(facility));
    const center = this.location ?? (firstMappedFacility && this.facilityHasCoordinates(firstMappedFacility)
      ? { latitude: firstMappedFacility.latitude, longitude: firstMappedFacility.longitude }
      : null);
    if (!container || !center) return;
    try {
      const leaflet = await this.loadLeaflet();
      if (!this.map) {
        this.map = leaflet.map(container, { zoomControl: false })
          .setView([center.latitude, center.longitude], this.location ? 13 : 11);
        leaflet.tileLayer(environment.mapTileUrl, {
          attribution: environment.mapAttribution,
          maxZoom: 19
        }).addTo(this.map);
        leaflet.control.zoom({ position: 'bottomright' }).addTo(this.map);
        this.markers = leaflet.layerGroup().addTo(this.map);
      } else {
        this.map.invalidateSize();
        this.map.setView([center.latitude, center.longitude], this.location ? 13 : 11);
      }
      this.markers?.clearLayers();
      if (this.location) {
        const locationLabel = this.locationSource === 'gps'
          ? 'Your current GPS location'
          : this.locationSource === 'municipality'
            ? 'Approximate municipality search location'
            : 'Your selected search location';
        leaflet.circleMarker([this.location.latitude, this.location.longitude], {
          radius: 9, color: '#fff', weight: 3, fillColor: '#0F8B8D', fillOpacity: 1
        }).bindPopup(locationLabel).addTo(this.markers!);
      }
      const mappedFacilities = this.facilities.filter((facility) => this.facilityHasCoordinates(facility));
      mappedFacilities.forEach((facility) => {
        leaflet.marker([facility.latitude, facility.longitude], {
          icon: leaflet.divIcon({
            className: `facility-marker ${facility.verificationStatus === 'verified' ? 'verified' : 'unverified'} ${facility.isActive ? 'active' : 'inactive'}`,
            html: `<span>${this.markerSymbol(facility.type)}</span>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18]
          })
        })
          .bindPopup(this.facilityPopup(facility))
          .on('click', () => { void this.openFacility(facility); })
          .addTo(this.markers!);
      });
      if (!this.location && mappedFacilities.length > 1) {
        this.map.fitBounds(
          leaflet.latLngBounds(mappedFacilities.map((facility) => [facility.latitude, facility.longitude])),
          { padding: [24, 24], maxZoom: 12 }
        );
      }
    } catch (error) {
      this.errorMessage = error instanceof Error
        ? `The map could not be loaded: ${error.message}`
        : 'The map could not be loaded. Check your connection and try again.';
    }
  }

  private loadLeaflet(): Promise<typeof import('leaflet')> {
    if (!this.leafletModule) {
      this.leafletModule = import('leaflet').catch((error: unknown) => {
        this.leafletModule = undefined;
        throw error;
      });
    }
    return this.leafletModule;
  }

  private markerSymbol(type: string): string {
    if (type === 'hospital' || type === 'clinic') return '+';
    if (type === 'fire_station') return 'F';
    if (type === 'police') return 'P';
    if (type === 'pharmacy') return '+';
    return '!';
  }

  private facilityPopup(facility: Facility): HTMLElement {
    const container = document.createElement('div');
    container.className = 'facility-popup';
    const title = document.createElement('strong');
    title.textContent = facility.name;
    const details = document.createElement('p');
    details.textContent = [
      this.facilityCategoryLabel(facility),
      facility.municipality,
      facility.address,
      facility.phone,
      facility.distanceKm !== undefined ? `${facility.distanceKm.toFixed(1)} km` : undefined
    ].filter(Boolean).join(' · ');
    const status = document.createElement('small');
    status.textContent = `${facility.verificationStatus ?? 'unverified'} · ${facility.isActive ? 'active' : 'inactive'}`;
    container.append(title, details, status);

    const phoneLink = this.facilityPhoneLink(facility.phone);
    if (phoneLink) {
      const call = document.createElement('button');
      call.type = 'button';
      call.textContent = `Call ${facility.phone}`;
      call.className = 'facility-popup-call';
      call.addEventListener('click', () => { void this.openPhoneDialer(facility.phone); });
      container.append(call);
      const smsLink = this.facilitySmsLink(facility.phone);
      if (smsLink) {
        const sms = document.createElement('button');
        sms.type = 'button';
        sms.textContent = `SMS ${facility.phone}`;
        sms.className = 'facility-popup-call';
        sms.addEventListener('click', () => { void this.openSmsComposer(facility.phone); });
        container.append(sms);
      }
    } else if (!facility.alternativePhone?.length) {
      const unavailable = document.createElement('span');
      unavailable.textContent = facility.phone
        ? `${facility.phone} · Invalid phone number`
        : 'Contact number unavailable';
      container.append(unavailable);
    }
    for (const phone of facility.alternativePhone ?? []) {
      if (!this.facilityPhoneLink(phone)) continue;
      const call = document.createElement('button');
      call.type = 'button';
      call.textContent = `Call ${phone}`;
      call.className = 'facility-popup-call';
      call.addEventListener('click', () => { void this.openPhoneDialer(phone); });
      container.append(call);
      if (this.facilitySmsLink(phone)) {
        const sms = document.createElement('button');
        sms.type = 'button';
        sms.textContent = `SMS ${phone}`;
        sms.className = 'facility-popup-call';
        sms.addEventListener('click', () => { void this.openSmsComposer(phone); });
        container.append(sms);
      }
    }
    return container;
  }

  private async geocode(query: string): Promise<GeocodingResult | null> {
    const key = query.toLocaleLowerCase();
    const cached = this.geocodeCache.get(key);
    if (cached && Date.now() - cached.savedAt < 10 * 60 * 1000) return cached.result;
    const delay = Math.max(0, 1100 - (Date.now() - this.lastGeocodeRequestAt));
    if (delay) await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      this.lastGeocodeRequestAt = Date.now();
      const url = new URL(environment.nominatimUrl);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('limit', '1');
      url.searchParams.set('q', query);
      const response = await fetch(url, {
        headers: { 'Accept-Language': 'en' },
        signal: controller.signal
      });
      if (!response.ok) throw new Error('Place search is temporarily unavailable. Please try again.');
      const places = await response.json() as GeocodingResult[];
      const result = places[0] ?? null;
      if (result) this.geocodeCache.set(key, { savedAt: Date.now(), result });
      return result;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('Place search timed out. Please try again.');
      }
      if (error instanceof TypeError) {
        throw new Error('Could not reach the place search service. Check your connection and retry.');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

}

interface GeocodingResult {
  lat: string;
  lon: string;
  display_name: string;
}

interface OsrmRouteResponse {
  routes?: Array<{
    distance: number;
    duration: number;
    geometry: { coordinates: [number, number][] };
  }>;
}
