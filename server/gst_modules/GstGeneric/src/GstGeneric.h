#include <napi.h>
#include <gst/gst.h>
#include <gtk/gtk.h>
#include <thread>
#include <iostream>

// Event emitter 
Napi::ThreadSafeFunction _emit;

// ====================================
// Helper functions 
// ====================================
/**
 * Event Emiter
*/
void Emit(const Napi::Env& env, const Napi::Function& emitFn, std::string message) {
    emitFn.Call({ Napi::String::New(env, message) });
}

// ====================================
// Init 
// ====================================
class _GstGeneric : public Napi::ObjectWrap<_GstGeneric> {
    public:
        static Napi::Object Init(Napi::Env env, Napi::Object exports);
        gboolean _w = false;
        _GstGeneric(const Napi::CallbackInfo &info);
        void th_Start();
        // Variables
        GstElement *pipeline;
        std::string _pipeline = "null"; 
        // Process varialbes 
        gboolean running = false;   // Gstreamer running state
        gboolean killing = false;   // Gstreamer killing state

    private:
        // Gstreamer Functions
        static Napi::FunctionReference constructor;
        Napi::Value Start(const Napi::CallbackInfo &info);
        Napi::Value Stop(const Napi::CallbackInfo &info);
        // Setters
        Napi::Value SetPipeline(const Napi::CallbackInfo &info);
        Napi::Value Set(const Napi::CallbackInfo &info);
        // Getters
        Napi::Value GetSrtStats(const Napi::CallbackInfo &info);
};

/**
 * Link Class to NAPI 
*/
Napi::Object _GstGeneric::Init(Napi::Env env, Napi::Object exports) {
    // This method is used to hook the accessor and method callbacks
    Napi::Function func = DefineClass(env, "_GstGeneric", {
        InstanceMethod("Start", &_GstGeneric::Start),
        InstanceMethod("Stop", &_GstGeneric::Stop),
        InstanceMethod("SetPipeline", &_GstGeneric::SetPipeline),
        InstanceMethod("Set", &_GstGeneric::Set),
        // getters 
        InstanceMethod("GetSrtStats", &_GstGeneric::GetSrtStats)
    });

    // Create a peristent reference to the class constructor. This will allow
    // a function called on a class prototype and a function
    // called on instance of a class to be distinguished from each other.
    constructor = Napi::Persistent(func);
    // Call the SuppressDestruct() method on the static data prevent the calling
    // to this destructor to reset the reference when the environment is no longer
    // available.
    constructor.SuppressDestruct();
    exports.Set("_GstGeneric", func);
    return exports;
}