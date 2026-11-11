export type EmergencyCategory =
  | 'medical'
  | 'fire'
  | 'police'
  | 'accident'
  | 'disaster'
  | 'other';

export interface Facility {
  id: string;
  name: string;
  type: string;
  category?: EmergencyCategory;
  latitude?: number;
  longitude?: number;
  address?: string;
  barangay?: string;
  municipality?: string;
  countryCode?: string;
  region?: string;
  phone?: string;
  alternativePhone?: string[];
  email?: string;
  emailVerified?: boolean;
  facebook?: string;
  facebookVerified?: boolean;
  facebookUrl?: string;
  website?: string;
  websiteVerified?: boolean;
  websiteUrl?: string;
  openingHours?: string;
  sourceUrl?: string;
  officialSourceUrl?: string;
  description?: string;
  verificationStatus?: 'verified' | 'unverified';
  isActive?: boolean;
  isPublic?: boolean;
  phoneVerified?: boolean;
  locationVerified?: boolean;
  isCallable?: boolean;
  legacyFacilityId?: string;
  createdAt?: Date | null;
  distanceKm?: number;
}

export interface UserLocation {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
}

export interface EmergencyReport {
  reportId: string;
  sourceCollection?: 'reports' | 'emergencyReports';
  userId: string;
  category: EmergencyCategory;
  description?: string;
  latitude?: number;
  longitude?: number;
  selectedFacilityName?: string;
  status: 'Submitted' | 'Under Review' | 'Resolved' | 'Closed';
  createdAt: Date;
}

export interface Hotline {
  id: string;
  name: string;
  type?: string;
  phoneNumber: string;
  phoneVerified?: boolean;
  alternativePhone?: string[];
  countryCode: string;
  region: string;
  municipality?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  category: EmergencyCategory;
  description: string;
  officialSourceUrl: string;
  sourceUrl?: string;
  email?: string;
  emailVerified?: boolean;
  facebook?: string;
  facebookVerified?: boolean;
  website?: string;
  websiteVerified?: boolean;
  openingHours?: string;
  locationVerified?: boolean;
  isCallable?: boolean;
  verificationStatus: 'verified' | 'unverified';
  isActive: boolean;
  isPublic?: boolean;
  legacyFacilityId?: string;
  lastVerifiedAt?: Date;
}

export interface EmergencyCategoryRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string;
  facilityTypes: string[];
  isActive: boolean;
  displayOrder: number;
}

export interface EmergencyGuide {
  id: string;
  title: string;
  category: EmergencyCategory;
  summary: string;
  instructions: string;
  sourceUrl: string;
  reviewedBy: string;
  isPublished: boolean;
}

export interface FacilitySuggestion {
  id: string;
  submittedBy: string;
  facilityName: string;
  facilityType: string;
  address?: string;
  latitude: number;
  longitude: number;
  contactNumber?: string;
  sourceUrl?: string;
  reviewStatus: 'pending' | 'approved' | 'rejected';
  reviewNote?: string;
  createdAt?: Date;
}
