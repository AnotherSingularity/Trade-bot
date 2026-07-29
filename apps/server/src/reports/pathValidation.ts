/**
 * Stage 4 §S4E — output-path validation (fail-closed).
 *
 * Called by the desktop main process BEFORE the export worker
 * writes an artifact. Rejects — with a specific reason code — any
 * output path that could let an attacker (or a bug) escape the
 * user's chosen target folder:
 *
 *   - `..` traversal in either the folder or the filename
 *   - UNC paths (`\\host\share`) on any platform
 *   - Drive-letter escapes (`C:\...`) unless the target folder is
 *     itself an absolute drive path and the resolved output stays
 *     inside it
 *   - Symlinks anywhere on the target path (resolved via realpath)
 *   - Filenames with path separators, NULs, or control chars
 *   - Filenames that end up outside the target folder after
 *     path.resolve() normalisation
 *
 * The check is performed on the RESOLVED absolute path so a
 * combination that individually looks safe (a folder + a "clean"
 * filename that contains a normalised `..`) is still caught by the
 * final "starts-with target folder" test.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export type PathRejectionReason =
  | 'target_folder_not_absolute'
  | 'target_folder_contains_traversal'
  | 'target_folder_unc'
  | 'target_folder_symlink'
  | 'target_folder_not_directory'
  | 'target_folder_missing'
  | 'filename_empty'
  | 'filename_has_separator'
  | 'filename_has_null_or_control_char'
  | 'filename_has_traversal'
  | 'filename_unc'
  | 'filename_absolute'
  | 'resolved_path_escapes_target'
  | 'resolved_path_contains_symlink';

export interface PathValidationInput {
  readonly targetFolder: string;
  readonly filename: string;
}

export interface PathValidationOk {
  readonly ok: true;
  readonly absolutePath: string;
}

export interface PathValidationErr {
  readonly ok: false;
  readonly reason: PathRejectionReason;
  readonly detail?: string;
}

export type PathValidationResult = PathValidationOk | PathValidationErr;

const UNC_PREFIX = /^(?:\\\\|\/\/)/;
const CONTROL_OR_NULL = /[\u0000-\u001f]/;
const NAME_HAS_SEPARATOR = /[\\/]/;

function containsTraversal(p: string): boolean {
  const parts = p.split(/[\\/]/).map((s) => s.trim());
  return parts.some((s) => s === '..');
}

/**
 * Validate synchronously WITHOUT touching disk. Callers that also
 * need the "no symlink" and "folder exists as directory" guarantees
 * must call `validateOutputPath()` (the async wrapper) instead.
 */
export function validateOutputPathSync(input: PathValidationInput): PathValidationResult {
  const target = input.targetFolder;
  const name = input.filename;

  if (name === '' || name.trim() === '') return { ok: false, reason: 'filename_empty' };
  if (CONTROL_OR_NULL.test(name)) return { ok: false, reason: 'filename_has_null_or_control_char' };
  if (NAME_HAS_SEPARATOR.test(name)) return { ok: false, reason: 'filename_has_separator' };
  if (containsTraversal(name)) return { ok: false, reason: 'filename_has_traversal' };
  if (UNC_PREFIX.test(name)) return { ok: false, reason: 'filename_unc' };
  if (path.isAbsolute(name)) return { ok: false, reason: 'filename_absolute' };

  if (UNC_PREFIX.test(target)) return { ok: false, reason: 'target_folder_unc' };
  if (!path.isAbsolute(target)) return { ok: false, reason: 'target_folder_not_absolute' };
  if (containsTraversal(target)) return { ok: false, reason: 'target_folder_contains_traversal' };

  const resolvedTarget = path.resolve(target);
  const resolvedOut = path.resolve(resolvedTarget, name);
  const rel = path.relative(resolvedTarget, resolvedOut);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: 'resolved_path_escapes_target' };
  }
  return { ok: true, absolutePath: resolvedOut };
}

/**
 * Full validation including symlink and directory-existence checks.
 * The target folder must exist and be a directory — the worker never
 * creates the folder itself (that's the desktop main's responsibility
 * so operator-owned permissions apply).
 */
export async function validateOutputPath(input: PathValidationInput): Promise<PathValidationResult> {
  const sync = validateOutputPathSync(input);
  if (!sync.ok) return sync;

  let stat;
  try {
    stat = await fs.stat(input.targetFolder);
  } catch {
    return { ok: false, reason: 'target_folder_missing' };
  }
  if (!stat.isDirectory()) return { ok: false, reason: 'target_folder_not_directory' };

  // Symlink check — realpath the target folder, then compare byte-
  // for-byte to the caller-supplied resolved path. If they differ
  // the folder itself is (or transits) a symlink and we refuse; the
  // user must supply the canonical path so the resolved output
  // cannot slip out via a symlinked prefix.
  try {
    const real = await fs.realpath(input.targetFolder);
    if (real !== path.resolve(input.targetFolder)) {
      return { ok: false, reason: 'target_folder_symlink' };
    }
  } catch {
    return { ok: false, reason: 'target_folder_missing' };
  }

  // The filename check above already refused traversal; nothing to
  // realpath on the output file itself (it doesn't exist yet).

  return sync;
}
