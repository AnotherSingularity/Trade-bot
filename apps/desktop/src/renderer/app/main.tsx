// Stage 3C-CI-FIX6 §2: RENDERER BOOTSTRAP MARKER — module entry.
// This runs BEFORE any React import work; if the renderer script
// gets loaded at all, this marker fires. The preload's
// `nativeDiagnosticsEnabled` boolean is exposed on `window.horizon`
// before this script executes (preload runs before renderer scripts
// per Electron contract). The check is defensive — a missing
// `window.horizon` never throws.
function emitNativeMarker(name: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = (globalThis as any).window?.horizon;
    if (h && h.nativeDiagnosticsEnabled === true) {
      // eslint-disable-next-line no-console
      console.log(name);
    }
  } catch { /* swallow — a marker MUST NEVER break the renderer */ }
}
emitNativeMarker('HORIZON_NATIVE_RENDERER_SCRIPT_ENTERED');

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('renderer_root_missing');

emitNativeMarker('HORIZON_NATIVE_RENDERER_ROOT_MOUNT_STARTED');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
emitNativeMarker('HORIZON_NATIVE_RENDERER_ROOT_MOUNTED');

// Stage 3C-CI-FIX4 marker — kept for backward compatibility. The
// harness readiness probe accepts either the marker OR the durable
// window flag below (§3: race-safe).
emitNativeMarker('HORIZON_NATIVE_RENDERER_BOOTSTRAPPED');

// Stage 3C-CI-FIX6 §3: durable readiness flag. Set on the window so
// the harness's `page.evaluate` probe can accept it even when the
// console-marker fired before the listener attached. Test-only —
// packaged/production builds never set it because
// nativeDiagnosticsEnabled is false.
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const h = (globalThis as any).window?.horizon;
  if (h && h.nativeDiagnosticsEnabled === true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window.__HORIZON_NATIVE_RENDERER_READY__ = true;
  }
} catch { /* swallow */ }
