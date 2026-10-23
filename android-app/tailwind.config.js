/** Tailwind 3 compilato in locale (al posto dello script CDN) così l'app funziona offline. */
module.exports = {
  darkMode: 'class',
  content: ['./www/**/*.html', './www/*.js', '!./www/vendor/**'],
  theme: { extend: {} },
  plugins: [],
};
