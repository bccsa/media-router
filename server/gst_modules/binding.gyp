{
  "targets": [
    {
      "target_name": "gstreamer",
      "sources": [
        "src/gstreamer.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<!@(pkg-config gstreamer-1.0 --cflags-only-I | sed s/-I//g)",
        "<!@(pkg-config gstreamer-video-1.0 --cflags-only-I | sed s/-I//g)",
        "<!@(pkg-config x11 --cflags-only-I | sed s/-I//g)",
        "/usr/include/gtk-3.0", 
        "/usr/include/glib-2.0",
        "/usr/include/pango-1.0",
        "/usr/include/harfbuzz",
        "/usr/include/cairo",
        "/usr/include/gdk-pixbuf-2.0",
        "/usr/include/atk-1.0",
        "/usr/lib/glib-2.0/include" 
      ],
      "libraries": [
        "<!@(pkg-config gstreamer-1.0 --libs)",
        "<!@(pkg-config gstreamer-video-1.0 --libs)",
        "<!@(pkg-config --cflags --libs x11)",
        "<!@(pkg-config --cflags --libs gtk+-3.0)" 
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_CPP_EXCEPTIONS"]
    } 
  ]
}