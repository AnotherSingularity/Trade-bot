# Horizon Trade — operational runbooks

Every runbook follows the same shape:

- **Trigger** — what event or symptom starts this runbook
- **Symptoms** — how the operator recognizes it
- **Immediate containment** — first steps to stop the bleeding
- **Diagnostic commands** — inspect state without changing anything
- **Recovery procedure** — restore normal operation
- **Verification** — prove the recovery worked
- **Escalation** — when to escalate and to whom
- **Data-preservation warning** — what NOT to delete
- **Safety implications** — impact on DRY_RUN / ORDER_SUBMISSION_ENABLED / live capital

## Index

1. [Desktop installation](01_desktop_installation.md)
2. [Desktop upgrade](02_desktop_upgrade.md)
3. [Desktop uninstall + data preservation](03_desktop_uninstall.md)
4. [Managed Docker setup](04_managed_docker_setup.md)
5. [External services setup](05_external_services_setup.md)
6. [Database migration](06_database_migration.md)
7. [Database backup and restore](07_database_backup_restore.md)
8. [Application rollback](08_application_rollback.md)
9. [Credential creation](09_credential_creation.md)
10. [Credential rotation](10_credential_rotation.md)
11. [Credential deletion](11_credential_deletion.md)
12. [Market-data outage](12_market_data_outage.md)
13. [Database outage](13_database_outage.md)
14. [Redis outage](14_redis_outage.md)
15. [Desktop crash loop](15_desktop_crash_loop.md)
16. [Server crash loop](16_server_crash_loop.md)
17. [Reconciliation degradation](17_reconciliation_degradation.md)
18. [Protection degradation](18_protection_degradation.md)
19. [Accounting discrepancy](19_accounting_discrepancy.md)
20. [Broken lineage](20_broken_lineage.md)
21. [Create Order barrier incident](21_create_order_barrier_incident.md)
22. [Preflight start](22_preflight_start.md)
23. [Preflight failure](23_preflight_failure.md)
24. [Soak start](24_soak_start.md)
25. [Soak reset](25_soak_reset.md)
26. [Code-freeze change control](26_code_freeze_change_control.md)
27. [Future live-canary emergency shutdown](27_live_canary_emergency_shutdown.md)

## Not executed in Phase 3B

Runbooks 22 (preflight start), 24 (soak start), and 27 (live-canary
emergency shutdown) are documented but **NOT** executed in Phase 3B.
The preflight and seven-day soak begin only after an operator issues
the Phase 3C authorization.
