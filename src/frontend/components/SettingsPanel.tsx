/**
 * Compatibility shim. The settings UI used to live as a single
 * 1700-line component in this file; it's been split into
 * `./settings/SettingsModal` plus per-panel components under
 * `./settings/panels/`. This module continues to export the same
 * `SettingsPanel` symbol so nothing outside the settings tree has to
 * be touched.
 */
export { SettingsModal as SettingsPanel } from "./settings/SettingsModal";
