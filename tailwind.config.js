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
        'circle_xmark_solid_blue': "url('./controls/img/circle_xmark_solid_blue.svg')",
        'xmark': "url('./controls/img/xmark.svg')",
        'cog_border': "url('./controls/img/cog_border.svg')",
        'cog_border2': "url('./controls/img/cog_border2.svg')",
        'cog_no_fill': "url('./controls/img/cog_no_fill.png')",
        'cog_test': "url('./controls/img/cog_test.png')",
      }
    }
  }

}