import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

const TOKEN_KEY = 'resq-it.access-token';

@Injectable({ providedIn: 'root' })
export class AuthTokenStore {
  private token: string | null = null;

  get accessToken(): string | null {
    return this.token;
  }

  async load(): Promise<string | null> {
    if (Capacitor.isNativePlatform()) {
      const { value: keys } = await SecureStoragePlugin.keys();
      this.token = keys.includes(TOKEN_KEY)
        ? (await SecureStoragePlugin.get({ key: TOKEN_KEY })).value
        : null;
      return this.token;
    }
    this.token = sessionStorage.getItem(TOKEN_KEY);
    return this.token;
  }

  async save(token: string): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await SecureStoragePlugin.set({ key: TOKEN_KEY, value: token });
    } else {
      sessionStorage.setItem(TOKEN_KEY, token);
    }
    this.token = token;
  }

  async clear(): Promise<void> {
    this.token = null;
    if (Capacitor.isNativePlatform()) {
      const { value: keys } = await SecureStoragePlugin.keys();
      if (keys.includes(TOKEN_KEY)) await SecureStoragePlugin.remove({ key: TOKEN_KEY });
      return;
    }
    sessionStorage.removeItem(TOKEN_KEY);
  }
}
