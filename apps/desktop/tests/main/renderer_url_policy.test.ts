/**
 * Stage 3C-CI-RESET Part 2 Checkpoint E.6 — every decision branch of
 * the pure renderer-URL policy resolver. These tests are the sole
 * proof that `HORIZON_RENDERER_URL` cannot cause a packaged installer
 * to point the privileged preload at an arbitrary remote origin.
 *
 * The resolver is pure — no Electron mock is needed. Callers are
 * required to throw on any `!allowed` decision BEFORE any
 * `new BrowserWindow(...)` is created, and `apps/desktop/src/main/index.ts`
 * does exactly that.
 */

import { describe, expect, it } from 'vitest';
import { resolveRendererUrl } from '../../src/main/rendererUrlPolicy';

const LAYOUT_URL = 'file:///app/dist/renderer/index.html';

describe('resolveRendererUrl', () => {
  // -------------------------------------------------------------------
  // Packaged: layout is authoritative; override is ALWAYS rejected.
  // -------------------------------------------------------------------

  it('packaged + no override → uses layout URL', () => {
    const d = resolveRendererUrl({ isPackaged: true, layoutRendererUrl: LAYOUT_URL, overrideEnv: undefined });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.url).toBe(LAYOUT_URL);
      expect(d.source).toBe('layout');
    }
  });

  it('packaged + empty override string → uses layout URL', () => {
    const d = resolveRendererUrl({ isPackaged: true, layoutRendererUrl: LAYOUT_URL, overrideEnv: '' });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.source).toBe('layout');
  });

  it('packaged + override http://127.0.0.1 → REJECTED (packaged wins)', () => {
    const d = resolveRendererUrl({
      isPackaged: true,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'http://127.0.0.1:5173',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_rejected_packaged');
  });

  it('packaged + override file:// → REJECTED (packaged always rejects override)', () => {
    const d = resolveRendererUrl({
      isPackaged: true,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'file:///tmp/index.html',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_rejected_packaged');
  });

  it('packaged + override https://evil.example.com → REJECTED', () => {
    const d = resolveRendererUrl({
      isPackaged: true,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'https://evil.example.com/index.html',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_rejected_packaged');
  });

  // -------------------------------------------------------------------
  // Development / test: no override → layout URL.
  // -------------------------------------------------------------------

  it('unpackaged + undefined override → uses layout URL', () => {
    const d = resolveRendererUrl({ isPackaged: false, layoutRendererUrl: LAYOUT_URL, overrideEnv: undefined });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.source).toBe('layout');
  });

  it('unpackaged + empty override → uses layout URL', () => {
    const d = resolveRendererUrl({ isPackaged: false, layoutRendererUrl: LAYOUT_URL, overrideEnv: '' });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.source).toBe('layout');
  });

  // -------------------------------------------------------------------
  // Development / test: valid overrides accepted.
  // -------------------------------------------------------------------

  it('unpackaged + http://127.0.0.1:5173 override → ACCEPTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'http://127.0.0.1:5173/',
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.url).toBe('http://127.0.0.1:5173/');
      expect(d.source).toBe('override');
    }
  });

  it('unpackaged + http://localhost:5173 override → ACCEPTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'http://localhost:5173/',
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.source).toBe('override');
  });

  it('unpackaged + https://localhost:5173 override → ACCEPTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'https://localhost:5173/',
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.source).toBe('override');
  });

  it('unpackaged + http://[::1]:5173 override → ACCEPTED (IPv6 loopback)', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'http://[::1]:5173/',
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.source).toBe('override');
  });

  it('unpackaged + file:///tmp/idx.html override → ACCEPTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'file:///tmp/idx.html',
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.source).toBe('override');
  });

  // -------------------------------------------------------------------
  // Development / test: invalid overrides REJECTED.
  // -------------------------------------------------------------------

  it('unpackaged + http://192.168.1.5:5173 override → REJECTED (non-loopback)', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'http://192.168.1.5:5173/',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe('override_non_loopback_http');
      expect(d.detail).toBe('192.168.1.5');
    }
  });

  it('unpackaged + https://evil.example.com override → REJECTED (non-loopback)', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'https://evil.example.com/idx.html',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_non_loopback_http');
  });

  it('unpackaged + userinfo present → REJECTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'http://user:pass@127.0.0.1:5173/',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_userinfo_present');
  });

  it('unpackaged + username only → REJECTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'http://alice@127.0.0.1:5173/',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_userinfo_present');
  });

  it('unpackaged + malformed URL → REJECTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'not a url',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_malformed_url');
  });

  it('unpackaged + javascript: scheme → REJECTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'javascript:alert(1)',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_disallowed_scheme');
  });

  it('unpackaged + data: scheme → REJECTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'data:text/html,<script>alert(1)</script>',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_disallowed_scheme');
  });

  it('unpackaged + ftp:// scheme → REJECTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'ftp://127.0.0.1/idx.html',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_disallowed_scheme');
  });

  it('unpackaged + chrome-devtools:// scheme → REJECTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'chrome-devtools://devtools/bundled/inspector.html',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_disallowed_scheme');
  });

  it('unpackaged + about:blank → REJECTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'about:blank',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_disallowed_scheme');
  });

  it('unpackaged + ws:// scheme → REJECTED', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: LAYOUT_URL,
      overrideEnv: 'ws://127.0.0.1:5173/',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('override_disallowed_scheme');
  });

  // -------------------------------------------------------------------
  // Layout URL malformation is a startup-abort condition.
  // -------------------------------------------------------------------

  it('malformed layout URL → REJECTED with layout_malformed_url', () => {
    const d = resolveRendererUrl({
      isPackaged: false,
      layoutRendererUrl: 'not a url',
      overrideEnv: undefined,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('layout_malformed_url');
  });

  it('malformed layout URL rejects even when packaged', () => {
    const d = resolveRendererUrl({
      isPackaged: true,
      layoutRendererUrl: 'not a url',
      overrideEnv: undefined,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('layout_malformed_url');
  });
});
