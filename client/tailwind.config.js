/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./**/*.{html,js}', './node_modules/tw-elements/dist/js/**/*.js'],
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
        'delete_bl': "url('./controls/img/delete_bl.svg')",
        'delete_wt': "url('./controls/img/delete_wt.svg')",
        'plus_circle_wt': "url('./controls/img/plus_circle_wt.svg')",
        'account': "url('./controls/img/account.svg')",
        'alert': "url('./controls/img/alert.svg')",
        'logout': "url('./controls/img/logout.svg')",
        'plus_circle_bl': "url('./controls/img/plus_circle_bl.svg')",
        'content_duplicate_wt': "url('./controls/img/content_duplicate_wt.svg')",
        'content_duplicate_bl': "url('./controls/img/content_duplicate_bl.svg')",
        'signal_gr': "url('./controls/img/signal_gr.svg')",
        'signal_bl': "url('./controls/img/signal_bl.svg')",
        'signal_red': "url('./controls/img/signal_red.svg')",
        'handel_drag': "url('./controls/img/handel_drag.svg')",
        'dots-six-vertical-bold': "url('./controls/img/dots-six-vertical-bold.svg')",
        'dots-vertical': "url('./controls/img/dots-vertical.svg')",
      }
    }
  }

}