import { EmergencyCategory, Facility } from '../models/emergency.models';

export type FacilityImportRecord = Omit<Facility, 'id' | 'distanceKm'>;

export interface FacilityCsvRow {
  line: number;
  facility: FacilityImportRecord;
  categoryLabel: string;
  errors: string[];
  warnings: string[];
  duplicateKey: string;
  duplicateType?: 'csv' | 'existing';
  duplicateOfId?: string;
  imported?: boolean;
  updated?: boolean;
  skipped?: boolean;
  importError?: string;
}

const fields = {
  name: ['facility name', 'facilityname', 'name'],
  type: ['facility type', 'facilitytype', 'facility kind', 'facilitykind', 'type'],
  category: ['category', 'emergency category', 'emergencycategory', 'facility category', 'facilitycategory'],
  municipality: ['municipality', 'municipality name', 'municipalityname', 'city', 'town'],
  region: ['region', 'province'],
  barangay: ['barangay'],
  address: ['complete address', 'completeaddress', 'address'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'lon', 'lng'],
  phone: ['contact number', 'phone', 'phone number', 'phonenumber', 'primary phone', 'primaryphone', 'contactnumber'],
  alternativePhone: ['alternative contact number', 'alternativecontactnumber', 'alternative phone', 'alternativephone', 'alternate phone', 'alternatephone', 'alternate contact number', 'alternatecontactnumber'],
  email: ['email', 'email address', 'emailaddress'],
  facebook: ['facebook page', 'facebookpage', 'facebook page url', 'facebookpageurl', 'facebook url', 'facebookurl', 'facebook'],
  website: ['website', 'website url', 'websiteurl', 'website link', 'websitelink'],
  openingHours: ['operating hours', 'operatinghours', 'opening hours', 'openinghours', 'hours'],
  sourceUrl: ['source url', 'official source url', 'officialsourceurl', 'sourceurl'],
  description: ['description', 'notes'],
  isPublic: ['is public', 'ispublic', 'public directory', 'show in public directory', 'showinpublicdirectory']
} as const;

const categoryMap: Record<string, { category: EmergencyCategory; label: string }> = {
  hospital: { category: 'medical', label: 'Hospital' },
  police_station: { category: 'police', label: 'Police' },
  clinic: { category: 'medical', label: 'Clinic' },
  diagnostic_center: { category: 'medical', label: 'Clinic' },
  dental_clinic: { category: 'medical', label: 'Clinic' },
  health_center: { category: 'medical', label: 'Clinic' },
  animal_bite_center: { category: 'medical', label: 'Clinic' },
  lying_in_clinic: { category: 'medical', label: 'Clinic' },
  barangay_hall: { category: 'other', label: 'Barangay' },
  fire_station: { category: 'fire', label: 'Fire' },
  pharmacy: { category: 'medical', label: 'Pharmacy' },
  rescue: { category: 'accident', label: 'Rescue' },
  rescue_station: { category: 'accident', label: 'Rescue' },
  accident: { category: 'accident', label: 'Accident / Rescue' },
  medical: { category: 'medical', label: 'Medical' },
  fire: { category: 'fire', label: 'Fire' },
  police: { category: 'police', label: 'Police' },
  disaster: { category: 'disaster', label: 'Disaster' },
  other: { category: 'other', label: 'Other' }
};

export function facilityDuplicateKey(name: string, category: string, municipality: string): string {
  return [
    normalizeDuplicatePart(name),
    normalizeCategoryForDuplicate(category),
    normalizeDuplicatePart(municipality)
  ].join('|');
}

export function parseFacilityCsv(text: string): FacilityCsvRow[] {
  const rows = parseRows(text);
  if (rows.length < 2) throw new Error('CSV needs a header and at least one facility row.');

  const headers = rows[0].map(normalizeHeader);
  const columns = Object.fromEntries(Object.entries(fields).map(([field, aliases]) => [
    field,
    headers.findIndex((header) => aliases.some((alias) => alias === header))
  ])) as Record<keyof typeof fields, number>;

  const missing: string[] = (['name', 'municipality'] as const)
    .filter((field) => columns[field] < 0);
  if (columns.category < 0 && columns.type < 0) missing.push('category or type');
  if (missing.length) throw new Error(`Missing CSV columns: ${missing.join(', ')}.`);

  const dataRows = rows.slice(1).filter((row) => row.some((value) => value.trim()));
  if (dataRows.length > 5000) throw new Error('Import at most 5,000 facility rows at a time.');

  const seen = new Set<string>();
  return dataRows.map((row, index) => {
    const value = (field: keyof typeof fields): string =>
      columns[field] < 0 ? '' : (row[columns[field]] ?? '').trim();

    const rawCategory = value('category');
    const rawType = value('type');
    const categoryValue = rawCategory || rawType;
    const type = rawType || rawCategory;
    const categoryMapping = categoryMap[normalizeCategoryValue(categoryValue)];
    const name = value('name');
    const municipality = value('municipality');
    const address = value('address');
    const latitudeText = value('latitude');
    const longitudeText = value('longitude');
    const latitude = latitudeText ? Number(latitudeText) : undefined;
    const longitude = longitudeText ? Number(longitudeText) : undefined;
    const sourceUrl = value('sourceUrl');
    const facebook = value('facebook');
    const website = value('website');
    const alternativePhones = value('alternativePhone')
      .split(/[|;]/)
      .map((phone) => phone.trim())
      .filter(Boolean);
    const validFacebook = facebook && isHttps(facebook) ? facebook : undefined;
    const validWebsite = website && isHttps(website) ? website : undefined;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (row.length > headers.length) errors.push('Row contains more values than the header');
    if (!name || name.length > 160) errors.push('Name required (max 160 chars)');
    if (!categoryValue) errors.push('Category is required');
    else if (!categoryMapping) errors.push(`Unsupported category: ${categoryValue}`);
    if (!municipality || municipality.length > 100) errors.push('Municipality required (max 100 chars)');
    if (type.length > 80) errors.push('Type exceeds 80 characters.');
    if (value('region').length > 120) errors.push('Region exceeds 120 characters.');
    if (address.length > 300) errors.push('Address exceeds 300 characters.');
    const latitudeValid = latitude !== undefined && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90;
    const longitudeValid = longitude !== undefined && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
    if (latitudeText && !latitudeValid) {
      warnings.push('Invalid latitude; location is unverified.');
    }
    if (longitudeText && !longitudeValid) {
      warnings.push('Invalid longitude; location is unverified.');
    }
    if (value('barangay').length > 100) errors.push('Barangay exceeds 100 characters.');
    if (value('phone').length > 40 || alternativePhones.some((phone) => phone.length > 40)) {
      errors.push('Phone number exceeds 40 characters.');
    }
    if (alternativePhones.length > 5) errors.push('At most 5 alternative phone numbers can be imported.');
    if (value('isPublic') && !['true', 'false'].includes(value('isPublic').toLocaleLowerCase())) {
      errors.push('Public directory must be true or false.');
    }
    if (value('email').length > 200) errors.push('Email exceeds 200 characters.');
    if (value('openingHours').length > 160) errors.push('Operating hours exceed 160 characters.');
    if (facebook && !validFacebook) warnings.push('Facebook URL does not use HTTPS and will not be imported.');
    if (website && !validWebsite) warnings.push('Website URL does not use HTTPS and will not be imported.');
    if (validFacebook && validFacebook.length > 500) errors.push('Facebook URL exceeds 500 characters.');
    if (validWebsite && validWebsite.length > 500) errors.push('Website URL exceeds 500 characters.');
    if (sourceUrl && (!isHttps(sourceUrl) || sourceUrl.length > 500)) {
      errors.push('Source URL must use HTTPS and be at most 500 characters.');
    }
    if (value('description').length > 500) errors.push('Description exceeds 500 characters.');

    if (!rawType) warnings.push('Type is missing; category used as the type fallback.');
    if (!address) warnings.push('Address is missing.');
    if (!latitudeValid || !longitudeValid) warnings.push('Coordinates are incomplete or invalid; location is unverified.');
    if (!value('phone')) warnings.push('No contact number.');
    if (!value('alternativePhone')) warnings.push('Alternative phone is missing.');
    if (!value('email')) warnings.push('Email is missing.');
    if (!value('facebook')) warnings.push('Facebook page is missing.');
    if (!value('website')) warnings.push('Website is missing.');
    if (!value('openingHours')) warnings.push('Operating hours are missing.');
    if (!sourceUrl) warnings.push('Source URL is missing.');

    const duplicateKey = facilityDuplicateKey(name, categoryValue, municipality);
    const duplicateType = seen.has(duplicateKey) ? 'csv' : undefined;
    if (duplicateType) warnings.push('Duplicate row in this CSV (same name, category, and municipality).');
    else seen.add(duplicateKey);

    const facility: FacilityImportRecord = {
      name,
      type,
      category: categoryMapping?.category ?? 'other',
      latitude: latitudeValid ? latitude : undefined,
      longitude: longitudeValid ? longitude : undefined,
      address,
      municipality,
      region: value('region') || '',
      phone: value('phone'),
      alternativePhone: alternativePhones.length ? alternativePhones : undefined,
      email: value('email') || undefined,
      facebook: validFacebook,
      facebookUrl: validFacebook,
      website: validWebsite,
      websiteUrl: validWebsite,
      openingHours: value('openingHours'),
      sourceUrl: sourceUrl || undefined,
      officialSourceUrl: sourceUrl || undefined,
      description: value('description') || undefined,
      verificationStatus: 'unverified',
      isActive: false,
      isPublic: value('isPublic').toLocaleLowerCase() === 'true',
      phoneVerified: false,
      locationVerified: false,
      isCallable: false
    };
    if (value('barangay')) facility.barangay = value('barangay');

    return {
      line: index + 2,
      facility,
      categoryLabel: categoryMapping?.label ?? categoryValue,
      errors,
      warnings,
      duplicateKey,
      ...(duplicateType ? { duplicateType } : {})
    };
  });
}

export function facilityCsvTemplate(): string {
  return 'name,category,type,municipality,address,latitude,longitude,phone,alternativePhone,email,facebook,website,openingHours,sourceUrl,description,isPublic';
}

function normalizeCategoryValue(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeCategoryForDuplicate(value: string): string {
  const normalized = normalizeCategoryValue(value);
  return categoryMap[normalized]?.category ?? normalized;
}

function normalizeDuplicatePart(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').trim().toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && !field.length) quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = '';
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else if (character === '"') throw new Error(`Malformed CSV near character ${index + 1}.`);
    else field += character;
  }
  if (quoted) throw new Error('Malformed CSV: an opening quote was not closed.');
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}
