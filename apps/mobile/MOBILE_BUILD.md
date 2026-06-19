# Building the Horizon Trade mobile app (EAS)

The app is an Expo (React Native) app in a monorepo. Builds run on EAS; the
backend URL is injected at build time via `EXPO_PUBLIC_API_URL`.

## One thing to set before building

Point the app at your deployed backend. Edit `apps/mobile/eas.json` and replace
the placeholder in the profile you're building:

```jsonc
// preview + production profiles:
"env": { "EXPO_PUBLIC_API_URL": "https://<your-app>.up.railway.app" }
```

(The `development` profile already points at `http://localhost:3000`.)

## Prerequisites (on your machine)

```bash
npm i -g eas-cli
eas login                 # Expo account
```

First build will prompt to create the EAS project and write its `projectId`
into the app config — accept it.

## Android — direct-install APK (recommended for your phone)

```bash
cd apps/mobile
eas build --profile preview --platform android
```

- Profile `preview` → `buildType: apk`, `distribution: internal`.
- When the build finishes, EAS prints a URL + QR code. Open it on your phone and
  install the APK directly (enable "install from unknown sources" if prompted).

## Other targets

```bash
# iOS simulator / dev client
eas build --profile development --platform ios

# Production store builds
eas build --profile production --platform android   # .aab (Play Store)
eas build --profile production --platform ios        # IPA (App Store / TestFlight)
```

## Notes

- **Monorepo:** `metro.config.js` watches the workspace root and resolves the
  hoisted `node_modules` + the `@horizon/shared` package. EAS installs deps from
  the repo root lockfile automatically.
- **Type safety:** the app imports the server's `AppRouter` **type only**
  (erased at build time), so server code is never bundled into the app.
- **Local smoke test without a build:** `cd apps/mobile && npx expo start`, then
  open in Expo Go (point `EXPO_PUBLIC_API_URL` at your machine's LAN IP, not
  `localhost`, when testing on a physical device).
