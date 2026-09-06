/* Local bootstrap for the private FLIPCOINS-only build. The captured original file was not present in the export. */
try {
  localStorage.setItem('currentCurrency','FLIPCOINS');
  localStorage.removeItem('api_override');
  localStorage.removeItem('action_env');
} catch (_) {}
