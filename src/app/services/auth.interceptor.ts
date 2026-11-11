import { inject } from '@angular/core';
import { HttpInterceptorFn } from '@angular/common/http';
import { from, switchMap } from 'rxjs';
import { AuthTokenStore } from './auth-token.store';
import { FirebaseService } from './firebase.service';
import { environment } from '../../environments/environment';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const firebase = inject(FirebaseService);
  const tokenStore = inject(AuthTokenStore);
  const apiBase = environment.backendApiBaseUrl.trim().replace(/\/+$/, '');
  if (!apiBase || !request.url.startsWith(`${apiBase}/`)) return next(request);
  if (firebase.currentUser) {
    return from(firebase.currentUser.getIdToken()).pipe(
      switchMap((token) => next(request.clone({
        setHeaders: { Authorization: `Bearer ${token}` }
      })))
    );
  }
  const token = tokenStore.accessToken;
  return token
    ? next(request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }))
    : next(request);
};
