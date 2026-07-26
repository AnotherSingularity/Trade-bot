; Phase 3A — NSIS installer include for Horizon Trade Desktop.
;
; Injected into the electron-builder NSIS template via the
; `include` property in package.json build.nsis (added at package
; time). Kept minimal and auditable — no obfuscation, no silent
; installers, no auto-start hooks.

!macro customHeader
  RequestExecutionLevel user
!macroend

!macro preInit
  ; The installer runs per-user by default; the operator explicitly
  ; picks the install directory.
  SetShellVarContext current
!macroend

!macro customInstall
  ; Write an install-time marker so the operator can prove which
  ; commit built this installer. The runtime reads it and surfaces
  ; it on the Overview + System screens.
  FileOpen $0 "$INSTDIR\\install-manifest.txt" w
  FileWrite $0 "Horizon Trade — Phase 3A operator console$\r$\n"
  FileWrite $0 "install_type=per_user$\r$\n"
  FileWrite $0 "safe_flags=DRY_RUN=true;ORDER_SUBMISSION_ENABLED=false$\r$\n"
  FileClose $0
!macroend

!macro customUninstall
  ; Never delete operator data on uninstall — logs, incidents and
  ; the desktop credential store persist unless explicitly removed
  ; by the operator via the Windows credential manager + Explorer.
!macroend
