export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

// localStorage can be blocked (private mode, strict settings); settings are only a convenience.
export function loadSetting(key) {
  try {
    return localStorage.getItem(`qr-beam:${key}`);
  } catch {
    return null;
  }
}

export function saveSetting(key, value) {
  try {
    localStorage.setItem(`qr-beam:${key}`, value);
  } catch {
    /* ignore */
  }
}
