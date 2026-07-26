# Desktop packaging resources

This directory is consumed by electron-builder at package time.

- `icon.ico` — Windows shell icon. Provide a real 256×256 icon
  before shipping an installer. A missing icon is not a code
  defect — electron-builder falls back to a generated icon during
  local development.

Nothing in this directory is executed at runtime. It is bundled
into the installer only.
