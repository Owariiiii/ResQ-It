# ResQ-It

ResQ-It is a mobile-first Ionic Angular emergency-assistance app. Firebase Authentication is the app's single sign-in and registration system; Firestore stores user profiles, emergency reports, suggestions, verified emergency facilities, hotlines, guides, and categories. A separate Node.js + Express + TypeScript backend provides protected administrator content operations and retains legacy MySQL API routes.

> **Emergency notice:** ResQ-It does not contact or dispatch emergency responders. If you are in immediate danger, call the appropriate local emergency service directly. Public facility data can be incomplete or outdated.

## Project layout

```text
ResQ-It/
├── backend/                  # Private Express API, MySQL schema, and API tests
│   ├── database/schema.sql
│   ├── src/
│   ├── tests/
│   ├── .env.example
│   └── package.json
├── src/                      # Ionic Angular + TypeScript mobile/web frontend
│   ├── app/services/         # API authentication, interceptor, and feature services
│   └── environments/         # Public app configuration and API URL
├── capacitor.config.ts
└── package.json              # Frontend scripts; backend remains a separate package
```

Frontend dependencies are installed at the project root. Backend packages, environment settings, tests, and database schema are isolated under `backend/`. Never place a backend secret or database credential in `src/`.

## Technology and features

- Angular 20, Ionic 8, TypeScript, and Capacitor 7.
- Node.js, Express 5, TypeScript, MySQL, mysql2, bcryptjs, Zod, and JWT.
- Firebase Authentication handles email/password signup, login, password reset, and sessions. New profiles are saved to `users/{uid}` with `role: "user"`.
- Only the exact existing administrator UID with a verified Firebase Admin SDK custom claim is treated as an administrator. A user-editable profile role never grants access.
- Firestore uses `emergencyHotlines` as the single official directory for facilities and hotline contacts; reports, facility suggestions, categories, and guides remain in their existing collections.
- The backend verifies Firebase ID tokens for admin operations. Legacy MySQL account routes are not used by the app's registration or login UI.
- Leaflet and OpenStreetMap tiles provide the map; nearby emergency facility records and callable phone numbers come from Firestore.
- The map tile URL and attribution are configured in `src/environments/environment.ts` and `environment.prod.ts`; OpenStreetMap tiles do not require an API key. Nominatim geocoding and OSRM routing URLs are configured there as well.
- Semaphore SMS provider settings belong in `backend/.env` (`SMS_API_URL`, `SMS_API_KEY`, and optional `SMS_SENDER_NAME`), never in the Angular environment because browser configuration is public. These settings only configure the provider; an SMS sending endpoint and user flow have not been implemented yet.

Firebase Authentication requires the Email/Password provider to be enabled in the Firebase project. User credentials are managed by Firebase Authentication; Firestore stores profiles and app records, never passwords.

## Firebase Authentication and administrator setup

The Firebase values in `src/environments/environment.ts` and `src/environments/environment.prod.ts` are client configuration, not Admin SDK credentials. Keep them consistent with the Firebase project. `CONFIGURATION_NOT_FOUND` means that Firebase Authentication has no sign-in configuration for that project/API key. In Firebase Console:

1. Select the `resq-it` project and open **Authentication**.
2. Select **Get started**, then **Sign-in method** and enable **Email/Password**.
3. Under **Authentication → Settings → Authorized domains**, ensure `localhost` is listed for local web development and add the production hostname before deployment. `ionic serve` should use `http://localhost`; if serving the app at `127.0.0.1`, add `127.0.0.1` to this allowlist too.
4. If the error remains, verify the Web API key belongs to this project and that Google Cloud API restrictions allow Firebase Authentication / Identity Toolkit.

To grant the supplied account administrator access, run the backend one-time command using trusted Firebase Admin credentials. Configure Application Default Credentials or `GOOGLE_APPLICATION_CREDENTIALS` to point to a service-account JSON file stored outside this repository. Set `FIREBASE_PROJECT_ID=resq-it` in `backend\.env`, then, from the `backend` folder, run:

```powershell
npm run grant-admin -- 279f5QypzDUvSe7diQl1AqlbUYK2
```

The command only grants the Firebase custom claim `admin: true` to that exact existing UID and preserves other claims. It refuses to modify any other account and does not create, delete, or change the administrator's email/password credentials. The account must already exist in the configured Firebase project. The administrator must sign in with the existing email and password, then sign out and back in after promotion to refresh the ID token. The app, backend, and Firestore rules require both the verified custom claim and this exact UID. Never set administrator status from registration or client-editable profile data.

If sign-in returns `auth/invalid-credential`, Firebase rejected the submitted email/password for the selected project. Confirm the account belongs to `resq-it` and enter its existing email/password exactly; passwords are not trimmed or changed by the app. A UID is not a login credential. Firebase may return this same error for multiple credential failures, so the app does not infer that an account is missing. The Firebase key's project number must match the configured app's sender ID. The app logs only the project ID and Firebase error code/message—not the email or password.

## 1. Prerequisites on Windows

Install:

1. Node.js 20.19 or newer and npm.
2. XAMPP with MySQL/MariaDB, or another compatible MySQL server.
3. A code editor such as Visual Studio Code.

Open **XAMPP Control Panel** and start **MySQL** for the backend's legacy API routes. The application itself authenticates with Firebase; the API verifies Firebase ID tokens for protected administrator operations.

## 2. Create the MySQL database

You can use phpMyAdmin (included with XAMPP):

1. Open `http://localhost/phpmyadmin`.
2. Sign in as a local database administrator.
3. Select the **Import** tab.
4. Choose `backend/database/schema.sql`, then select **Import**.
5. Confirm that the `resq_it` database contains `users`, `emergency_reports`, and `facility_suggestions`.

For deployment, create a dedicated database user with permissions only on the `resq_it` database. Do not use the MySQL root account for the hosted API. In phpMyAdmin, use **User accounts → Add user account**, choose a strong password, grant only the privileges needed on `resq_it`, and use that username/password in the API `.env`.

The `users` table has a case-insensitive unique email index. Passwords are saved only as bcrypt hashes. The database role column defaults to `user`; the registration SQL also explicitly inserts `user`.

## 3. Configure and start the private API

In PowerShell:

```powershell
Set-Location C:\xampp\htdocs\ResQ-It\backend
Copy-Item .env.example .env
notepad .env
```

Set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` to match MySQL. Generate a unique JWT secret:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Copy the output into `JWT_SECRET` in `backend\.env`. Do not share or commit that secret. The backend refuses to start if it is missing or shorter than 64 characters. `.env` is ignored by Git; only `.env.example` is included.

Install, test, build, and start the API:

```powershell
npm install
npm test
npm run build
npm run dev
```

The API listens on `http://localhost:3000`. Check readiness at `http://localhost:3000/api/health`. Keep this terminal open while developing. For a production server, use `npm start` after `npm run build` and run the API with a process manager or hosted service.

The `backend` package has its own `package.json` and lockfile. From the project root, `npm test` also runs the backend API test suite.

## 4. Connect and run the frontend

The development API root is configured as `http://127.0.0.1:3000/api` in `src/environments/environment.ts`. Keep the backend running, then open a second PowerShell window:

```powershell
Set-Location C:\xampp\htdocs\ResQ-It
npm install
npm start
```

Open the Angular URL printed in the terminal (normally `http://localhost:4200`). User registration, login, profile, reports, and suggestions use Firebase Authentication and Firestore. The backend remains required for administrator content operations.

For Android, a device's `localhost` is the device itself, not your PC. Use the deployed HTTPS API URL in `src/environments/environment.prod.ts` before producing a release build. For local emulator development, Android emulators commonly reach the host through `10.0.2.2`; a physical device needs the PC's LAN IP, firewall access, and a development network configuration. Do not ship an APK configured for plain HTTP or a development host.

## 5. Backend API endpoints

All paths below are prefixed with `/api`. The `/auth/*`, `/users/*`, and `/account/*` MySQL endpoints are retained for legacy/manual clients; the Angular app does not use them for registration, login, profiles, reports, or suggestions. Do not use the legacy registration endpoint to create application accounts.

| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| `POST` | `/auth/register` | Public, rate-limited | Create a user account and return a JWT |
| `POST` | `/auth/login` | Public, rate-limited | Verify email/password and return a JWT |
| `GET` | `/auth/me` | Signed in | Get the current user's profile and role |
| `PUT` | `/users/profile` | Signed in | Update own name and contact details |
| `PUT` | `/users/change-password` | Signed in | Verify current password, change password, and revoke prior tokens |
| `GET` | `/account/reports` | Signed in | Read only the caller's report records |
| `POST` | `/account/reports` | Signed in | Save a private app report |
| `POST` | `/account/facility-suggestions` | Signed in | Submit a facility suggestion for review |
| `/admin/*` | Admin routes | Admin role only | Manage Firestore public content and review private submissions |

Admin routes include `GET /admin/dashboard`, category/hotline/guide CRUD under `/admin/categories`, `/admin/hotlines`, and `/admin/guides`. They accept Firebase ID tokens only when Firebase Admin SDK verifies both the `admin: true` claim and the configured administrator UID. Firestore rules separately protect reports and suggestion reviews.

### Test with Postman

1. Send `POST http://localhost:3000/api/auth/register` with:

   ```json
   {
     "fullName": "Alex Responder",
     "email": "alex@example.com",
     "password": "ChooseARealPassword123!",
     "phoneNumber": "+639171234567"
   }
   ```

2. Save the returned `token`. The response contains a safe `user` object, never a password or hash.
3. Send `GET http://localhost:3000/api/auth/me` with header `Authorization: Bearer <token>`.
4. Try `PUT /api/users/profile` with the same header and a JSON body containing `fullName` and any optional contact fields.
5. Send a duplicate registration and confirm it returns `409`. Send a wrong login password and confirm it returns the same generic `401` message used for a nonexistent account.
6. Register a second ordinary user and try `GET /api/admin/dashboard`; it must return `403`.

For application admin access, use the existing Firebase administrator account and the custom-claim setup described above. A MySQL `admin` role or a client-supplied role cannot grant access to the application administrator routes.

## 6. Administrator accounts and Firestore

Application registration always creates Firebase profiles with role `user`; the only administrator is the exact UID and verified Firebase custom claim described above. Do not promote accounts by editing a MySQL role.

Administrator directory edits use Firestore rules and require the exact administrator UID plus its verified Firebase custom claim. Backend API operations remain server-side and independently verify Firebase ID tokens. Never put service-account credentials in the frontend or source control.

Deploy Firestore access rules and composite indexes after changing the Firebase project:

```powershell
npx firebase-tools deploy --only firestore:rules,firestore:indexes
```

## 7. CORS and deployment

`CORS_ORIGINS` is a comma-separated allowlist. Local browser and Capacitor origins are included in `backend/.env.example`. For production, replace them with the exact HTTPS web origin and the Capacitor origins used by your Android/iOS app; do not use `*`. Requests without an `Origin` header (for example, server-to-server tools) are permitted, but they still need valid authentication for protected routes.

For online deployment:

1. Provision MySQL and a restricted application database user.
2. Import `backend/database/schema.sql`.
3. Configure all backend environment variables in the hosting provider's secret manager, including a fresh `JWT_SECRET`. Do not upload `.env`.
4. Configure Firebase Admin credentials server-side if admin Firestore editing is needed.
5. Serve the API behind HTTPS, restrict inbound database access, and configure production `CORS_ORIGINS`.
6. Set `backendApiBaseUrl` in `src/environments/environment.prod.ts` to `https://your-api-host/api`.
7. Build the frontend with `npm run build`; production Angular builds use `environment.prod.ts` and reject non-HTTPS API URLs.

Local development uses `http://127.0.0.1:3000`; a deployed API is reachable by a phone over HTTPS from anywhere permitted by the server. Do not expose MySQL directly to the mobile app or the public internet.

## Firebase and map features retained

- `src/environments/environment.ts` retains the Firebase web-app configuration previously provided. Firebase client configuration is public; it is not an admin credential.
- Existing Firebase Authentication accounts are used as-is; the specified administrator does not need to register again. Ordinary new registrations use Firebase Authentication and profiles are saved in Firestore.
- Firestore stores the user profile, reports, suggestions, facilities, hotlines, guides, and categories. Administrator content changes use the authenticated API/Firebase Admin SDK or Firestore rules for facilities; both enforce the exact admin UID and verified custom claim.
- The Angular app connects to the `resq-it` Firestore project via `environment.firebase.projectId`. `emergencyHotlines` is the sole collection for official facilities and hotline contacts. `emergencyFacilities` is retained read-only for administrator migration; original documents are not deleted. Report reads also check `emergencyReports` for backward compatibility. Firestore is not Realtime Database, and the configured Realtime Database URL is not used for these reads.
- Public facilities and hotlines come from `emergencyHotlines`: active records and administrator-published `isPublic == true` review records are shown. Any valid phone number on a visible record opens the device dialer or SMS composer on user tap, including numbers not yet verified by an administrator. The app does not place calls or send messages automatically; users confirm in their device app. Unverified contacts remain clearly labeled and should be checked before use. Nearby requests can also filter by category and municipality; results without coordinates remain available for area searches and sort after located facilities. GPS results prioritize active records, then sort by distance; selecting a municipality uses its approximate center. Browser geolocation is used if the Capacitor geolocation provider fails.
- Facility records require only `name`, `category`, and `municipality`. Contact details, address, region, source URL, and coordinates are optional. A provided source URL must use HTTPS. Missing or invalid coordinates do not block import and leave the location unverified. Active records are visible publicly with their verification status; any syntactically valid phone number is available through a user-initiated dialer/SMS link, with verification status shown separately.
- Emergency numbers saved by an administrator for `Oriental Mindoro` appear in the nearby results panel and hotline directory. Add only numbers checked against an official source, mark them verified and active, and select the correct emergency category. ResQ-It does not fabricate missing phone numbers.
- Admin → Hotlines is the only official-directory management interface. It lists all `emergencyHotlines` records (active/inactive, public/private, verified/unverified), supports search and category/municipality/verification/status filters, CSV import, editing, verification, activation, deletion, and refresh. CSV imports start inactive and unverified; `isPublic=true` makes a record visible to users. Valid phone numbers in displayed records remain tappable, with verification labels shown separately. Verified existing duplicates are not overwritten. `alternativePhone` accepts up to five phone numbers separated by `|` or `;`.
- **Migrate Existing Facilities to Hotlines** copies legacy `emergencyFacilities` records into `emergencyHotlines` in Firestore batches. Admins can migrate all records or use “Migrate & edit” on one legacy contact. It preserves source data in the destination, records the source ID as `legacyFacilityId`, skips existing destination matches, reports progress/results, and leaves original source documents untouched. Migrated records are editable from Admin → Hotlines. Migration is safe to rerun.
- Local development (`ionic serve`) sets `directoryTestingMode` to preload `src/dev-data/emergencyFacilities.seed.csv` as a clearly labeled local preview and merge it with canonical Firebase records. It contains user-supplied records; local contacts remain inactive and unverified. Valid contact numbers open the device dialer/SMS composer on tap, but users should confirm them because ResQ-It has not verified them. The verified administrator can inspect inactive and unverified canonical records. Production does not package or load the preview CSV and uses active or explicitly public `emergencyHotlines` records.
- Firestore read diagnostics write the project ID, collection, query conditions, authenticated UID, and result count or Firebase error code to the browser console. Permission failures require deployed rules; missing-index errors require deployed indexes. Deploy rules and indexes with `firebase deploy --only firestore:rules,firestore:indexes`; the composite indexes are defined in `firestore.indexes.json`.
- Leaflet and OpenStreetMap tiles display Firestore facility markers; optional Nominatim place search and OSRM routing remain separate from facility authorization.

## Android build

Install Android Studio, Android SDK, and JDK 17 or a compatible version. Configure the production API URL first, then:

```powershell
Set-Location C:\xampp\htdocs\ResQ-It
npm run build
npx cap add android
npx cap sync android
npx cap open android
```

Build the APK in Android Studio, or use `.\gradlew.bat assembleDebug` from the `android` folder. Do not distribute a build containing development URLs, an HTTP production endpoint, MySQL credentials, or JWT signing secrets.

## Security notes

- Firebase Authentication manages application passwords and sessions; plaintext passwords are never stored in Firestore.
- Firebase Admin SDK verifies ID tokens for administrator operations and requires the exact configured UID plus `admin: true`. Database roles and editable profile fields do not grant application admin access.
- Legacy MySQL account endpoints retain their existing JWT and password-hashing protections, but are not used by the Angular app.
- SQL values are parameterized. Input validation, Helmet headers, JSON size limits, CORS allowlisting, and authentication rate limits are enabled.
- `backend/.env` and service-account files are secrets. Never commit them or copy them into the Angular project.
- HTTPS is required for the production frontend/API connection.


## Run the Ionic app

Open the project root (the folder containing `ionic.config.json`) in VS Code, then run:

```powershell
ionic serve
```

Do not use `npm run` to start the Ionic development server. Keep your existing root `.env` / Firebase environment values and your existing `backend/.env`; these private files are intentionally not included in shared project archives.

## Emergency directory data flow

`emergencyHotlines` is the canonical directory. Admin → Hotlines includes a read-only preview of Firestore `emergencyFacilities`, a migration action, and a CSV importer. `data/emergency-contact-import.csv` contains the 59 user-provided listings that had contact numbers (61 numbers total). Sign in as the verified administrator, deploy the Firestore rules, preview the CSV for existing duplicates, then import it. Those rows are explicitly public for directory display and remain inactive/unverified until reviewed. Any valid displayed phone number opens the device dialer or SMS composer on user tap, but users should confirm unverified numbers before proceeding. The import is not automatic and no records are written to Firebase until an authenticated administrator confirms the import. The local development preview is separate and is not included in production builds. Only the designated UID with the Firebase `admin: true` custom claim can write hotline records.

## Codemagic iOS build

The root `codemagic.yaml` builds an Ad Hoc IPA with Capacitor app ID `com.app.resqit`. Configure a matching Ad Hoc signing certificate and provisioning profile in Codemagic, including the target iPhone UDID. Push this project to its intended GitHub repository, select the `ios-sideloadly` workflow in Codemagic, then download the `.ipa` artifact from the completed build. Install it with Sideloadly; if Sideloadly re-signs the IPA, use the Apple ID/team associated with the device.

After replacing `firestore.rules` and `firestore.indexes.json`, deploy the rules from the project root:

```powershell
firebase deploy --only firestore:rules,firestore:indexes
```

If the app still shows that the admin claim is missing, grant the custom claim once using the existing trusted Firebase Admin SDK setup. In PowerShell, from the project root:

```powershell
cd backend
node --import tsx scripts/grant-admin.ts 279f5QypzDUvSe7diQl1AqlbUYK2
```

This one-time command requires `FIREBASE_PROJECT_ID=resq-it` in `backend/.env` and Google Application Default Credentials (or a configured `GOOGLE_APPLICATION_CREDENTIALS` service-account file path). After it succeeds, sign out of the app and sign in again so Firebase refreshes the ID token.
