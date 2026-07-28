/**
 * Stage 3C-E.1 §D — pure Electron native-launch policy.
 *
 * `resolveNativeLaunchPolicy(input)` is the ONLY sanctioned way to
 * compose the CLI switches + env variables the native test harness
 * passes to Electron. It enforces the following invariants:
 *
 *  1. **Default canonical launch has NO sandbox-disabling switches.**
 *     `--no-sandbox`, `--disable-setuid-sandbox`,
 *     `HORIZON_ELECTRON_NO_SANDBOX`, and `ELECTRON_DISABLE_SANDBOX`
 *     are NOT present in the canonical launch.
 *
 *  2. **A fallback exists ONLY behind an explicit, test-only opt-in.**
 *     The environment variable `HORIZON_NATIVE_ALLOW_NO_SANDBOX=true`
 *     is the sole activation gate. Non-canonical values are rejected.
 *
 *  3. **Packaged mode structurally refuses the opt-in.**
 *     An installer that somehow carries the env variable cannot
 *     activate the fallback — the decision function ignores the env
 *     when `isPackaged=true` and reports a policy_rejected reason.
 *
 *  4. **Production mode (NODE_ENV!=='test') refuses the opt-in.**
 *     A developer machine running Electron with `NODE_ENV=production`
 *     cannot activate the fallback either.
 *
 *  5. **CI alone does not activate the fallback.**
 *     Setting `CI=true` (as GitHub Actions does) is NOT sufficient —
 *     only the explicit `HORIZON_NATIVE_ALLOW_NO_SANDBOX=true` opt-in
 *     turns the flags on, and even then only in test + unpackaged.
 *
 *  6. **When the fallback IS active, the decision reports
 *     `sandboxDisabled=true`** so downstream evidence records that
 *     the run is NON-CERTIFIABLE even if every behavioral assertion
 *     passes.
 *
 * The pure decision result is consumed by
 * `apps/desktop/tests/native/electronHarness.ts` to compose the actual
 * `_electron.launch({args, env})` call. It has zero side effects and
 * touches no I/O.
 */

export interface NativeLaunchPolicyInput {
  readonly isPackaged: boolean;
  readonly nodeEnv: string | undefined;
  readonly noSandboxOptIn: string | undefined;
}

export type NativeLaunchPolicyReason =
  | 'canonical_sandboxed'
  | 'fallback_active_test_only_opt_in'
  | 'fallback_ignored_packaged'
  | 'fallback_ignored_non_test_node_env'
  | 'fallback_ignored_non_canonical_opt_in';

export interface NativeLaunchPolicyDecision {
  /**
   * When true, the harness should append the sandbox-disabling flags
   * to `args` and mark the run non-certifiable.
   */
  readonly sandboxDisabled: boolean;
  /**
   * Additional Chromium CLI switches to append. Frozen tuple, always
   * empty when `sandboxDisabled=false`. When `sandboxDisabled=true`
   * this contains exactly the three canonical Chromium sandbox-disable
   * switches, no more, no less.
   */
  readonly extraArgs: readonly string[];
  /**
   * Additional env variables to inject into the Electron child. Frozen
   * record. Only populated in fallback mode; the two entries mirror
   * the Chromium-recognised env twins of the flags so any early
   * pre-command-line sandbox check sees consistent state.
   */
  readonly extraEnv: Readonly<Record<string, string>>;
  /**
   * Stable classification tag; use for evidence + tests.
   */
  readonly reason: NativeLaunchPolicyReason;
}

/**
 * Chromium sandbox-disabling switches. Exported so tests can pin the
 * exact tuple and detect a future silent addition.
 */
export const SANDBOX_DISABLE_SWITCHES = Object.freeze([
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
] as const);

/**
 * Chromium-recognised env twins of the sandbox-disable switches. The
 * `ELECTRON_DISABLE_SANDBOX` variable is checked before command line
 * parsing in Electron; keeping both in sync avoids the reader
 * confusion the pre-E.1 code caused.
 */
export const SANDBOX_DISABLE_ENV = Object.freeze({
  HORIZON_ELECTRON_NO_SANDBOX: 'true',
  ELECTRON_DISABLE_SANDBOX: '1',
} as const);

const CANONICAL_DECISION: NativeLaunchPolicyDecision = Object.freeze({
  sandboxDisabled: false,
  extraArgs: Object.freeze([] as readonly string[]),
  extraEnv: Object.freeze({}),
  reason: 'canonical_sandboxed',
});

/**
 * Pure. Returns the launch policy decision for the native Electron
 * harness. Callers MUST pass the returned `extraArgs` after their
 * canonical arg list (main-entry, --user-data-dir=…) and MUST merge
 * `extraEnv` into the Electron child env exactly as-is.
 *
 * Rejection reasons DO NOT throw — they downgrade to the canonical
 * sandboxed decision so a misconfigured env can never make the fallback
 * active. The `reason` field records WHY the fallback was not applied.
 */
export function resolveNativeLaunchPolicy(input: NativeLaunchPolicyInput): NativeLaunchPolicyDecision {
  // 1. Packaged installer: structural refusal. `sandboxDisabled` MUST
  //    remain false regardless of any env value.
  if (input.isPackaged) {
    if (input.noSandboxOptIn != null && input.noSandboxOptIn.length > 0) {
      return {
        sandboxDisabled: false,
        extraArgs: [],
        extraEnv: {},
        reason: 'fallback_ignored_packaged',
      };
    }
    return CANONICAL_DECISION;
  }
  // 2. No opt-in present → canonical.
  if (input.noSandboxOptIn == null || input.noSandboxOptIn.length === 0) {
    return CANONICAL_DECISION;
  }
  // 3. Non-canonical value ('1', 'yes', 'TRUE', ' true', …) → ignore.
  if (input.noSandboxOptIn !== 'true') {
    return {
      sandboxDisabled: false,
      extraArgs: [],
      extraEnv: {},
      reason: 'fallback_ignored_non_canonical_opt_in',
    };
  }
  // 4. NODE_ENV must be exactly 'test'. A dev / production Electron
  //    launch cannot activate the fallback.
  if (input.nodeEnv !== 'test') {
    return {
      sandboxDisabled: false,
      extraArgs: [],
      extraEnv: {},
      reason: 'fallback_ignored_non_test_node_env',
    };
  }
  // 5. All gates cleared: fallback active. Non-certifiable run.
  return {
    sandboxDisabled: true,
    extraArgs: [...SANDBOX_DISABLE_SWITCHES],
    extraEnv: { ...SANDBOX_DISABLE_ENV },
    reason: 'fallback_active_test_only_opt_in',
  };
}
