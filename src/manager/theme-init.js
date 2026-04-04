// Runs before CSS to prevent flash of wrong theme (FOUC).
// Must be loaded synchronously in <head> before the stylesheet.
(function () {
  var saved = localStorage.getItem('themePreference');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
