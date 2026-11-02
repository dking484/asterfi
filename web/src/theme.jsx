// UI themes. index.html applies the saved one before React loads so the page never flashes the wrong colors;
// signed-in users also keep their choice on the server so it follows them to other browsers.
import { api } from './api.js';

export const THEMES = [
  { id: 'dark', label: 'Dark', swatch: { nav: '#031021', bg: '#0f1c2c', bar: '#3fd3e0', line: '#223244' } },
  { id: 'light', label: 'Light', swatch: { nav: '#ffffff', bg: '#f4f5f6', bar: '#006fff', line: '#e3e5e8' } },
];
export const DEFAULT_THEME = 'dark';
const KEY = 'asterfi-theme';

export function currentTheme() {
  return document.documentElement.dataset.theme || DEFAULT_THEME;
}

export function applyTheme(theme) {
  const t = THEMES.some((x) => x.id === theme) ? theme : DEFAULT_THEME;
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* private mode: the server copy still applies on sign-in */ }
  return t;
}

export async function saveTheme(theme) {
  const t = applyTheme(theme);
  await api.put('/api/my/theme', { theme: t });
  return t;
}

// The logo, in the version that suits the active theme (CSS picks which one shows).
export function BrandLogo({ className = '' }) {
  return (
    <>
      <img className={`brand-logo for-light ${className}`} src="/logo-light.png" alt="AsterFi" />
      <img className={`brand-logo for-dark ${className}`} src="/logo-dark.png" alt="AsterFi" />
    </>
  );
}
