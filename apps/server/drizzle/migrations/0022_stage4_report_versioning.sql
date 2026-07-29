-- Stage 4 §S4.0 — deterministic report versioning + idempotency.
--
-- Additive DDL. Migrations 0000-0021 remain immutable.
--
-- Existing-row-safe: every new column is NULLABLE at add time; the
-- export worker always populates non-null values on write (job
-- creation for reportSpecVersion/sourceHighWaterMark/idempotencyKey,
-- artifact-completion for contentDigest). Stage 3 never inserted a
-- row into desktop_export_jobs (the exportReport IPC handler
-- returned a fixed stub without any DB write), so this migration
-- has no rows to backfill in practice; the NULL columns exist to
-- keep the migration structurally safe even in a future scenario
-- where Stage 3-era rows survive.
--
-- Idempotency (Stage 4 correction: "must be enforced by a database
-- uniqueness constraint, not application-only check-then-insert
-- logic"): idempotencyKey is a deterministic hash of the tuple
-- (installationId, reportKind, referenceId, sourceHighWaterMark).
-- UNIQUE constraint on idempotencyKey. MySQL/MariaDB permits
-- multiple NULLs in a UNIQUE index (standard SQL for UNIQUE with
-- NULLs), so existing NULL-keyed rows do not conflict; new rows
-- written by the worker always carry a non-null key.
--
-- contentDigest is the SHA256 of the canonical pre-format report
-- payload. It is stable across format=json|csv|html output for the
-- same source data at the same sourceHighWaterMark. Non-participating
-- fields (generatedAt, jobId, requestedAt, installation metadata,
-- artifact paths) are excluded from the canonical payload by the
-- generator itself so the digest is deterministic across re-runs.

ALTER TABLE `desktop_export_artifacts` ADD `contentDigest` varchar(64);--> statement-breakpoint
ALTER TABLE `desktop_export_jobs` ADD `reportSpecVersion` varchar(32);--> statement-breakpoint
ALTER TABLE `desktop_export_jobs` ADD `sourceHighWaterMark` json;--> statement-breakpoint
ALTER TABLE `desktop_export_jobs` ADD `idempotencyKey` varchar(128);--> statement-breakpoint
ALTER TABLE `desktop_export_jobs` ADD CONSTRAINT `desk_exp_job_idem_uq` UNIQUE(`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `desk_exp_art_content_idx` ON `desktop_export_artifacts` (`contentDigest`);--> statement-breakpoint
CREATE INDEX `desk_exp_job_kind_status_idx` ON `desktop_export_jobs` (`reportKind`,`status`,`requestedAt`);
