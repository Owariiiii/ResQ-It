import { EmergencyCategory } from '../models/emergency.models';

export interface HotlineCsvEntry {
  name: string;
  phoneNumber: string;
  countryCode: string;
  region: string;
  category: EmergencyCategory;
  description: string;
  officialSourceUrl: string;
}

const HEADER_ALIASES: Record<keyof HotlineCsvEntry, string[]> = {
  name: ['name', 'hotline name', 'facility name'],
  phoneNumber: ['phonenumber', 'phone number', 'phone', 'number'],
  countryCode: ['countrycode', 'country code', 'country'],
  region: ['region', 'province', 'area'],
  category: ['category', 'type'],
  description: ['description', 'notes'],
  officialSourceUrl: ['officialsourceurl', 'official source url', 'sourceurl', 'source url', 'source']
};

export function parseHotlineCsv(text: string): HotlineCsvEntry[] {
  const rows = parseRows(text);
  if (rows.length < 2) throw new Error('The CSV must include a header row and at least one contact.');

  const headers = rows[0].map(normalizeHeader);
  const columns = Object.fromEntries(
    Object.entries(HEADER_ALIASES).map(([field, aliases]) => [
      field,
      headers.findIndex((header) => aliases.includes(header))
    ])
  ) as Record<keyof HotlineCsvEntry, number>;
  const required: Array<keyof HotlineCsvEntry> = ['name', 'region', 'category'];
  const missing = required.filter((field) => columns[field] < 0);
  if (missing.length) {
    throw new Error(`Missing required CSV columns: ${missing.join(', ')}.`);
  }

  const dataRows = rows.slice(1).filter((row) => row.some((value) => value.trim()));
  if (dataRows.length > 100) throw new Error('Import up to 100 contacts per CSV file.');
  const entries: HotlineCsvEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  dataRows.forEach((row, index) => {
    const line = index + 2;
    const value = (field: keyof HotlineCsvEntry): string =>
      columns[field] < 0 ? '' : (row[columns[field]] ?? '').trim();
    const name = value('name');
    const phoneNumber = value('phoneNumber');
    const countryCode = value('countryCode').toUpperCase();
    const region = value('region');
    const category = parseCategory(value('category'));
    const description = value('description');
    const officialSourceUrl = value('officialSourceUrl');
    const issues: string[] = [];
    if (!name || name.length > 120) issues.push('name is required (max 120 characters)');
    if (phoneNumber && (!/^\+?[0-9\s().-]+$/.test(phoneNumber)
      || phoneNumber.replace(/\D/g, '').length < 3
      || phoneNumber.replace(/\D/g, '').length > 15)) {
      issues.push('phone number is invalid');
    }
    if (countryCode && !/^[A-Z]{2,3}$/.test(countryCode)) issues.push('country code must be an ISO code such as PH');
    if (!region || region.length > 120) issues.push('region is required (max 120 characters)');
    if (!category) issues.push('category must be medical, fire, police, accident, disaster or other');
    if (description.length > 500) issues.push('description exceeds 500 characters');
    if (officialSourceUrl) {
      try {
        if (new URL(officialSourceUrl).protocol !== 'https:' || officialSourceUrl.length > 500) {
          issues.push('official source must be a valid HTTPS URL');
        }
      } catch {
        issues.push('official source must be a valid HTTPS URL');
      }
    }

    const duplicateKey = `${name.normalize('NFKC').trim().toLocaleLowerCase()}|${category ?? ''}|${region.normalize('NFKC').trim().toLocaleLowerCase()}`;
    if (seen.has(duplicateKey)) issues.push('duplicate phone number and region');
    if (issues.length) {
      errors.push(`Row ${line}: ${issues.join('; ')}.`);
      return;
    }
    seen.add(duplicateKey);
    entries.push({
      name,
      phoneNumber,
      countryCode,
      region,
      category: category!,
      description,
      officialSourceUrl
    });
  });

  if (errors.length) throw new Error(errors.slice(0, 10).join(' ') + (errors.length > 10 ? ` And ${errors.length - 10} more row errors.` : ''));
  if (!entries.length) throw new Error('No contacts were found in the CSV.');
  return entries;
}

function normalizeHeader(header: string): string {
  return header.replace(/^\uFEFF/, '').trim().toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function parseCategory(value: string): EmergencyCategory | null {
  const normalized = value.trim().toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (['medical', 'health', 'healthcare', 'hospital', 'clinic'].includes(normalized)) return 'medical';
  if (['fire', 'fire station'].includes(normalized)) return 'fire';
  if (['police', 'police station'].includes(normalized)) return 'police';
  if (normalized === 'accident') return 'accident';
  if (normalized === 'disaster') return 'disaster';
  if (['other', 'general'].includes(normalized)) return 'other';
  return null;
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
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && !field.length) {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = '';
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else if (character === '"') {
      throw new Error(`Malformed CSV: unexpected quote near character ${index + 1}.`);
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('Malformed CSV: a quoted field is not closed.');
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}
