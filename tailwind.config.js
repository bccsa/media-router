/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./client/**/*.{html,js}', './node_modules/tw-elements/dist/js/**/*.js'],
  plugins: [
    require('tw-elements/dist/plugin')
  ],

  theme: {
    extend: {
      backgroundImage: {
        'cog_solid': "url('./controls/img/cog_solid.svg')",
      }
    }
  }

}