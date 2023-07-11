const { addDynamicIconSelectors } = require('@iconify/tailwind');


/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./**/*.{html,js}', "../local-profileman/**/*.{html,js}", '../local-profileman/node_modules/tw-elements/dist/js/**/*.js'],

  plugins: [
    // tw-elements plugin
    require("../local-profileman/node_modules/tw-elements/dist/plugin.js"),
    // Iconify plugin
    addDynamicIconSelectors()
    // require('@iconify/tailwind')()
  ],

  
}