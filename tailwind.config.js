/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./client/**/*.{html,js}', './node_modules/tw-elements/dist/js/**/*.js', './node_modules/*.html'],
  plugins: [
    require('tw-elements/dist/plugin')
  ],

  theme: {
    extend: {
      backgroundImage: {
        'cog_solid': "url('./controls/img/cog_solid.svg')",
        'circle_xmark_solid_blue': "url('./controls/img/circle_xmark_solid_blue.svg')",
        'xmark': "url('./controls/img/xmark.svg')",
        'cog_outline': "url('./controls/img/cog_outline.svg')",
        'delete': "url('./controls/img/delete.svg')",
        'plus_circle': "url('./controls/img/plus_circle.svg')",
        'account': "url('./controls/img/account.svg')",
      }
    }
  }

}