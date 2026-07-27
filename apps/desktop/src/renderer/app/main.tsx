import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('renderer_root_missing');

// Stage 3C-CI-FIX4 §A5: emit the fixed renderer bootstrap marker
// ONLY when the desktop main tells us diagnostics are on. The main
// exposes this flag via a preload boolean it built from
// nativeDiagnosticsEnabled({ isPackaged, nodeEnv, optIn }). Packaged
// installers and production builds structurally cannot enable it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ((window as any).horizon?.nativeDiagnosticsEnabled === true) {
  // eslint-disable-next-line no-console
  console.log('HORIZON_NATIVE_RENDERER_BOOTSTRAPPED');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
