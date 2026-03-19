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
        "<!@(pkg-config gstreamer-video-1.0 --cflags-only-I | sed s/-I//g)"
      ],
      "libraries": [
        "<!@(pkg-config gstreamer-1.0 --libs)",
        "<!@(pkg-config gstreamer-video-1.0 --libs)"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_CPP_EXCEPTIONS"]
    } 
  ]
}