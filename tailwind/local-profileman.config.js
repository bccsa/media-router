const { addDynamicIconSelectors } = require('@iconify/tailwind');


/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./**/*.{html,js}', "../local-profileman/**/*.{html,js}", '../local-profileman/node_modules/tw-elements/dist/js/**/*.js'],

  plugins: [
    // tw-elements plugin
    require("../client/node_modules/tw-elements/dist/plugin.js"),
    require('@tailwindcss/typography'),
    // Iconify plugin
    addDynamicIconSelectors()
  ],

  
}