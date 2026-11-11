import { Injectable } from '@angular/core';
import { Geolocation } from '@capacitor/geolocation';
import { UserLocation } from '../models/emergency.models';

@Injectable({ providedIn: 'root' })
export class LocationService {
  async getCurrentLocation(): Promise<UserLocation> {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      throw new Error('Location is not available in this browser. Search for a place instead.');
    }

    try {
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: false,
        timeout: 8000,
        maximumAge: 120000
      });
      return {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy
      };
    } catch (capacitorError) {
      try {
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: false,
            timeout: 10000,
            maximumAge: 120000
          });
        });
        return {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy
        };
      } catch (browserError) {
        const details = browserError instanceof Error && browserError.message
          ? browserError.message
          : capacitorError instanceof Error && capacitorError.message
            ? capacitorError.message
            : 'Check location permission and try again.';
        throw new Error(`Unable to get your current location: ${details}`);
      }
    }
  }
}
