#include <napi.h>
#include <thread>
#include <gst/gst.h>
#include <iostream>

/* Structure to contain all our information, so we can pass it to callbacks */
typedef struct _CustomData {
    // src
    GstElement *srtsrc;
    GstElement *tsparse;
    GstElement *tsdemux;
    GstElement *opusdec;
    GstElement *audioconvert;
    GstElement *audioresample;
    GstElement *queue;
    GstElement *pulsesink;
} CustomData;

// ====================================
// Helper functions 
// ====================================
/**
 * Event Emiter
*/
void Emit(const Napi::Env& env, const Napi::Function& emitFn, std::string level, std::string message) {
    emitFn.Call({ Napi::String::New(env, level), Napi::String::New(env, message) });
}

// ====================================
// Pad linking
// ====================================
/**
 * Link pads sink
*/
static void on_pad_added (GstElement *element, GstPad *pad, gpointer data)
{
    GstPad *sinkpad;
    GstElement *gl_item = (GstElement *) data;
    
    /* We can now link this pad with the sink pad */
    g_print ("Dynamic pad created\n");
    
    sinkpad = gst_element_get_static_pad (gl_item, "sink");
    gst_pad_link (pad, sinkpad);
    gst_object_unref (sinkpad);
}

// ====================================
// Init 
// ====================================
class _SrtOpusInput : public Napi::ObjectWrap<_SrtOpusInput> {
    public:
        static Napi::Object Init(Napi::Env env, Napi::Object exports);
        _SrtOpusInput(const Napi::CallbackInfo &info);
        // Gstreamer functions
        void th_Start();
        // Variables
        std::string _sink = "null";
        std::string _uri = "null";
        // Process varialbes 
        GMainLoop *loop;
        // Event emitter 
        Napi::ThreadSafeFunction _emit;
    private:
        // Gstreamer Functions
        static Napi::FunctionReference constructor;
        Napi::Value Start(const Napi::CallbackInfo &info);
        Napi::Value Stop(const Napi::CallbackInfo &info);
        // Setters
        Napi::Value SetUri(const Napi::CallbackInfo &info);
        Napi::Value SetSink(const Napi::CallbackInfo &info);
};

/**
 * Link Class to NAPI 
*/
Napi::Object _SrtOpusInput::Init(Napi::Env env, Napi::Object exports) {
    // This method is used to hook the accessor and method callbacks
    Napi::Function func = DefineClass(env, "_SrtOpusInput", {
        InstanceMethod("Start", &_SrtOpusInput::Start),
        InstanceMethod("Stop", &_SrtOpusInput::Stop),
        InstanceMethod("SetUri", &_SrtOpusInput::SetUri),
        InstanceMethod("SetSink", &_SrtOpusInput::SetSink),
    });

    // Create a peristent reference to the class constructor. This will allow
    // a function called on a class prototype and a function
    // called on instance of a class to be distinguished from each other.
    constructor = Napi::Persistent(func);
    // Call the SuppressDestruct() method on the static data prevent the calling
    // to this destructor to reset the reference when the environment is no longer
    // available.
    constructor.SuppressDestruct();
    exports.Set("_SrtOpusInput", func);
    return exports;
}

// ====================================
// Constructor 
// ====================================
/**
 * [0] - _uri - Srt url - default: null
 * [1] - _sink - Pulse audio device - default: null
*/
_SrtOpusInput::_SrtOpusInput(const Napi::CallbackInfo &info) : Napi::ObjectWrap<_SrtOpusInput>(info) {
    int len = info.Length();

    if (len >= 1 && info[0].IsString() ) { this->_uri = info[0].As<Napi::String>().Utf8Value(); } else { std::cout <<  Napi::String::New(info.Env(), "_uri not supplied or invalid type\n"); };
    if (len >= 2 && info[1].IsString() ) { this->_sink = info[1].As<Napi::String>().Utf8Value(); } else { std::cout <<  Napi::String::New(info.Env(), "_sink not supplied or invalid type\n"); }
}

Napi::FunctionReference _SrtOpusInput::constructor;

// ====================================
// _SrtOpusInput Class 
// ====================================

Napi::Value _SrtOpusInput::Start(const Napi::CallbackInfo &info){

    if (info.Length() < 1) {
        std::cout << "Callback function required";
        return Napi::String::New(info.Env(), "Callback function required");
    } else {
        // Thread safe emitter (https://github.com/nodejs/node-addon-api/blob/main/doc/threadsafe_function.md | https://chat.openai.com/share/229b5d00-3033-4f4f-9848-ed5e93c9498e)
        this->_emit = Napi::ThreadSafeFunction::New(
            info.Env(),
            info[0].As<Napi::Function>(),  // JavaScript function called asynchronously
            "emitter",              // Name
            0,                      // Unlimited queue
            1                       // Only one thread will use this initially
        );
        std::thread t1([this] { this->th_Start(); });
        t1.detach();

        return Napi::String::New(info.Env(), "Pipline started");
    }
}

Napi::Value _SrtOpusInput::Stop(const Napi::CallbackInfo &info){
    // Stop pipeline
    g_main_loop_quit(this->loop);
    return Napi::String::New(info.Env(), "Pipline stopped");
    
}

// --------
// Setters
// --------
/**
 * [0] - _uri - Srt url - default: null
*/
Napi::Value _SrtOpusInput::SetUri(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { this->_uri = info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "_uri not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _sink - Pulse audio sink - default: null
*/
Napi::Value _SrtOpusInput::SetSink(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { this->_sink = info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "_sink not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}

// ====================================
// Start Gstreamer
// ====================================

/**
 * Callback messages from bus
*/
static gboolean my_bus_callback (GstBus * bus, GstMessage * message, gpointer data)
{
    _SrtOpusInput *obj = (_SrtOpusInput *) data;
    switch (GST_MESSAGE_TYPE (message)) {
        case GST_MESSAGE_ERROR:{
            std::string errorMessage;
            GError *err;
            gchar *debug;
            gst_message_parse_error (message, &err, &debug);
            g_print ("Error: %s\n", err->message);
        
            // https://chat.openai.com/share/6654604b-6271-4b02-a84e-6d72fe9a5a25
            obj->_emit.NonBlockingCall([err](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "FATAL", g_strdup(err->message)); });

            g_error_free (err);
            g_free (debug);

            obj->_emit.NonBlockingCall([err](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "FATAL", "Restarting pipeline due to a fatal error"); });
            //restarting on FATAL error
            g_main_loop_quit(obj->loop);
            obj->th_Start();

            break;
        }
        case GST_MESSAGE_EOS:
            /* end-of-stream */
            obj->_emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "INFO", "EOS"); });
            //restarting on EOS
            g_main_loop_quit(obj->loop);
            obj->th_Start();
            break;
        default:
            break;
    }
    /* we want to be notified again the next time there is a message
    * on the bus, so returning TRUE (FALSE means we want to stop watching
    * for messages on the bus and our callback should not be called again)
    */
    return TRUE;
}

/**
 * Start Gstreamer in a seperate thread
*/
void _SrtOpusInput::th_Start() {
    this->_emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "INFO", "Pipeline started"); });
    /* Varaibles */
    CustomData gl;
    // Gstreamer
    GstBus *bus;
    GstElement *pipeline;

    /* Initialize GStreamer */
    gst_init (NULL, NULL);
    this->loop = g_main_loop_new (NULL, FALSE);

    /* ------------------------------ Prep pipline -------------------------------- */

    /* Create the elements */
    gl.srtsrc = gst_element_factory_make ("srtsrc", "srtsrc");
    gl.tsparse = gst_element_factory_make ("tsparse", "tsparse");
    gl.tsdemux = gst_element_factory_make ("tsdemux", "tsdemux");
    gl.opusdec = gst_element_factory_make ("opusdec", "opusdec");
    gl.audioconvert = gst_element_factory_make ("audioconvert", "audioconvert");
    gl.audioresample = gst_element_factory_make ("audioresample", "audioresample");
    gl.queue = gst_element_factory_make ("queue", "queue");
    gl.pulsesink = gst_element_factory_make ("pulsesink", "pulsesink");

    /* Create the empty pipeline */
    pipeline = gst_pipeline_new ("pipeline");

    if (!pipeline || !gl.srtsrc || !gl.tsparse || !gl.tsdemux ||
        !gl.opusdec || !gl.audioconvert || !gl.audioresample || !gl.queue || !gl.pulsesink) { 
        g_printerr ("Not all elements could be created.\n");
    }

    /* Configure elements */
    // src
    g_object_set (gl.srtsrc, "uri", this->_uri.c_str(), NULL);
    g_object_set (gl.srtsrc, "wait-for-connection", false, NULL);
    g_object_set (gl.tsparse, "ignore-pcr", true, NULL); 
    g_object_set (gl.tsdemux, "latency", (guint64)1, NULL);    
    g_object_set (gl.tsdemux, "ignore-pcr", true, NULL);     
    g_object_set (gl.pulsesink, "sync", false, NULL); 
    g_object_set (gl.pulsesink, "device", this->_sink.c_str(), NULL);   
    g_object_set (gl.pulsesink, "buffer-time", (guint64)20000, NULL);   // value need to be cast to guint64 (https://gstreamer-devel.narkive.com/wr5HjCpX/gst-devel-how-to-set-max-size-time-property-of-queue)
    g_object_set (gl.pulsesink, "max-lateness", (guint64)1000000, NULL); // value need to be cast to guint64 (https://gstreamer-devel.narkive.com/wr5HjCpX/gst-devel-how-to-set-max-size-time-property-of-queue)
    // queue's
    g_object_set (gl.queue, "leaky", 2, NULL);   
    g_object_set (gl.queue, "max-size-time", (guint64)1000000000, NULL); // value need to be cast to guint64 (https://gstreamer-devel.narkive.com/wr5HjCpX/gst-devel-how-to-set-max-size-time-property-of-queue)

    /* Link all elements that can be automatically linked because they have "Always" pads */
    gst_bin_add_many (GST_BIN (pipeline), gl.srtsrc, gl.tsparse, gl.tsdemux,
        gl.opusdec, gl.audioconvert, gl.audioresample, gl.queue, gl.pulsesink, NULL);

    // /* Linking */
    if (// src
        gst_element_link_many (gl.srtsrc, gl.tsparse, gl.tsdemux, NULL) != TRUE ||
        // sink
        gst_element_link_many (gl.opusdec, gl.audioconvert, gl.audioresample, gl.queue, gl.pulsesink, NULL) != TRUE) 
    {
        g_printerr ("Elements could not be linked.\n");
        gst_object_unref (pipeline); 
    }

    /* add pad */
    g_signal_connect (gl.tsdemux, "pad-added", G_CALLBACK (on_pad_added), gl.opusdec);

    /* ------------------------------ Prep pipline -------------------------------- */

    /* Start playing the pipeline */
    gst_element_set_state (pipeline, GST_STATE_PLAYING);

    /* Wait until error or EOS */
    bus = gst_element_get_bus (pipeline);

    gst_bus_add_watch (bus, my_bus_callback, this);
    gst_object_unref (bus);

    g_main_loop_run (this->loop);

    /* ------------------------------- Post cleanup -------------------------------- */
    this->_emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "INFO", "Pipeline stopped"); });

    gst_element_set_state(pipeline, GST_STATE_NULL);
    gst_object_unref (pipeline);
    gst_object_unref (this->loop);

    this->_emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "INFO", "Resource cleanup complete"); });
    /* ------------------------------- Post cleanup -------------------------------- */
}