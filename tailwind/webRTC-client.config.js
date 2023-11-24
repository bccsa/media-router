const { addDynamicIconSelectors } = require('@iconify/tailwind');


/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./**/*.{html,js}', "../webRTC-client/**/*.{html,js}"],

  plugins: [
    // Iconify plugin
    addDynamicIconSelectors()
  ],

  
}