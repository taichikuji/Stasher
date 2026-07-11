// Runs before CSS to prevent flash of wrong theme (FOUC).
// Must be loaded synchronously in <head> before the stylesheet.
(function () {
  var saved = localStorage.getItem('themePreference');
  var theme = saved === 'light' || saved === 'dark'
    ? saved
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
})();
