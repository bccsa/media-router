//const { addDynamicIconSelectors } = require('@iconify/tailwind');


/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./**/*.{html,js}', "../local-client/**/*.{html,js}"],

  plugins: [
    // tw-elements plugin
    //require("../local-client/node_modules/tw-elements/dist/plugin.js"),
    // Iconify plugin
    //addDynamicIconSelectors()
    // require('@iconify/tailwind')()
  ],

  
}