const { addDynamicIconSelectors } = require('@iconify/tailwind');


/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./**/*.{html,js}', "../client/controls/**/*.{html,js}", '../client/node_modules/tw-elements/dist/js/**/*.js'],

  plugins: [
    // tw-elements plugin
    require("../client/node_modules/tw-elements/dist/plugin.js"),
    // Iconify plugin
    addDynamicIconSelectors()
  ],
}