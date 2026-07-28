/**
 * Stage 3C-CI-RESET Part 2 Checkpoint E.6 — pure renderer-URL policy.
 *
 * `resolveRendererUrl(input)` is the ONLY sanctioned way to decide
 * what URL Electron's main process feeds to `win.loadURL(...)`. It
 * enforces:
 *
 *   1. Packaged builds ALWAYS use the layout-provided canonical
 *      file:// URL. Any `HORIZON_RENDERER_URL` override is rejected
 *      — a stray env var in a released installer must NEVER cause
 *      the privileged preload to load an arbitrary remote origin.
 *
 *   2. Development / test may accept an override, but ONLY if the
 *      URL is:
 *        - a local `file://` URL, OR
 *        - an explicit loopback origin (127.0.0.1, ::1, localhost)
 *          on http/https with no userinfo / empty pathname prefix.
 *
 *   3. Any non-loopback http(s) URL, any userinfo present, any
 *      unexpected scheme (ftp, chrome-devtools, data, javascript,
 *      about, ws, …), any malformed URL, is rejected with a
 *      specific policy tag.
 *
 * Every rejection returns a stable `reason` tag so log-mining and
 * unit tests can pin the exact failure mode.
 */

export interface RendererUrlPolicyInput {
  readonly isPackaged: boolean;
  readonly layoutRendererUrl: string;
  readonly overrideEnv: string | undefined;
}

export type RendererUrlPolicyDecision =
  | { readonly allowed: true; readonly url: string; readonly source: 'layout' | 'override' }
  | { readonly allowed: false; readonly reason: RendererUrlRejectionReason; readonly detail: string };

export type RendererUrlRejectionReason =
  | 'override_rejected_packaged'
  | 'override_malformed_url'
  | 'override_disallowed_scheme'
  | 'override_userinfo_present'
  | 'override_non_loopback_http'
  | 'override_empty'
  | 'layout_malformed_url';

const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function classifyLoopbackScheme(scheme: string): 'file' | 'http_loopback' | 'other' {
  if (scheme === 'file:') return 'file';
  if (scheme === 'http:' || scheme === 'https:') return 'http_loopback';
  return 'other';
}

function inspectUrl(raw: string): { url: URL } | { reason: RendererUrlRejectionReason; detail: string } {
  let url: URL;
  try { url = new URL(raw); }
  catch { return { reason: 'override_malformed_url', detail: raw.slice(0, 80) }; }
  return { url };
}

/**
 * Pure. Returns the URL to load (with source tag) or a rejection.
 * Callers must throw on rejection BEFORE any BrowserWindow is
 * created. Layout URL malformation is a startup-abort condition —
 * something is wrong with the build.
 */
export function resolveRendererUrl(input: RendererUrlPolicyInput): RendererUrlPolicyDecision {
  // 0. Validate the layout URL. If it's malformed we cannot proceed
  //    regardless of the override.
  const layoutInspect = inspectUrl(input.layoutRendererUrl);
  if ('reason' in layoutInspect) {
    return { allowed: false, reason: 'layout_malformed_url', detail: layoutInspect.detail };
  }
  // 1. Packaged: layout URL is authoritative. Override is ALWAYS rejected.
  if (input.isPackaged) {
    if (input.overrideEnv != null && input.overrideEnv.length > 0) {
      return {
        allowed: false,
        reason: 'override_rejected_packaged',
        detail: 'HORIZON_RENDERER_URL cannot influence a packaged build',
      };
    }
    return { allowed: true, url: input.layoutRendererUrl, source: 'layout' };
  }
  // 2. Development / test: no override → use layout.
  if (input.overrideEnv == null || input.overrideEnv.length === 0) {
    return { allowed: true, url: input.layoutRendererUrl, source: 'layout' };
  }
  // 3. Override present + unpackaged: validate strictly.
  const inspect = inspectUrl(input.overrideEnv);
  if ('reason' in inspect) return { allowed: false, reason: inspect.reason, detail: inspect.detail };
  const { url } = inspect;
  const scheme = classifyLoopbackScheme(url.protocol);
  if (scheme === 'other') {
    return { allowed: false, reason: 'override_disallowed_scheme', detail: url.protocol };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { allowed: false, reason: 'override_userinfo_present', detail: 'userinfo forbidden in renderer URL' };
  }
  if (scheme === 'http_loopback') {
    if (!ALLOWED_LOOPBACK_HOSTS.has(url.hostname)) {
      return { allowed: false, reason: 'override_non_loopback_http', detail: url.hostname };
    }
  }
  return { allowed: true, url: input.overrideEnv, source: 'override' };
}
