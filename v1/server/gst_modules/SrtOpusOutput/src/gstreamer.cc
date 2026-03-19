#include "SrtOpusOutput.h"

// ====================================
// Main gstreamer class (Class links to all sub modules)
// ====================================
// Initialize native add-on
Napi::Object Init (Napi::Env env, Napi::Object exports) {
    _SrtOpusOutput::Init(env, exports);
    return exports;
}

// Register and initialize native add-on
NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
