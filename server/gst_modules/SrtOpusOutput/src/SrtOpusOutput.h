#include <napi.h>
#include <thread>
#include <gst/gst.h>
#include <unistd.h>
#include <iostream>

/* Structure to contain all our information, so we can pass it to callbacks */
typedef struct _CustomData {
    // src
    GstElement *source;
    GstCaps *caps;
    GstElement *audioconvert;
    GstElement *audioresample;
    GstElement *a_convert_queue;
    GstElement *opusenc;
    GstElement *mpegtsmux;
    GstElement *srtsink;
} CustomData;

// ====================================
// Helper functions 
// ====================================
/**
 * Event Emiter
*/
void Emit(const Napi::Env& env, const Napi::Function& emitFn, std::string message) {
    try {
        emitFn.Call({ Napi::String::New(env, message) });
    } catch (std::logic_error& e) {
        std::cout << "logic_error thrown" << std::endl;
    }
} 

// ====================================
// Init 
// ====================================
class _SrtOpusOutput : public Napi::ObjectWrap<_SrtOpusOutput> {
    public:
        static Napi::Object Init(Napi::Env env, Napi::Object exports);
        _SrtOpusOutput(const Napi::CallbackInfo &info);
        // Gstreamer functions
        void th_Start();
        void reload_srt();
        // Variables
        std::string _device = "null";
        int _paLatency = 50;
        int _sampleRate = 48000;
        std::string _bitDepth = "S16LE";
        int _channels = 2;
        int _bitrate = 64000;
        std::string _uri = "null";
        CustomData gl;
        // Process varialbes 
        GMainLoop *loop;
        GstElement *pipeline;
        // Event emitter 
        Napi::ThreadSafeFunction _emit; 

    private:
        // Gstreamer Functions
        static Napi::FunctionReference constructor;
        Napi::Value Start(const Napi::CallbackInfo &info);
        Napi::Value Stop(const Napi::CallbackInfo &info);
        // Setters
        Napi::Value SetDevice(const Napi::CallbackInfo &info);
        Napi::Value SetPALatency(const Napi::CallbackInfo &info);
        Napi::Value SetSampleRate(const Napi::CallbackInfo &info);
        Napi::Value SetBitDepth(const Napi::CallbackInfo &info);
        Napi::Value SetChannels(const Napi::CallbackInfo &info);
        Napi::Value SetBitrate(const Napi::CallbackInfo &info);
        Napi::Value SetUri(const Napi::CallbackInfo &info);
};

/**
 * Link Class to NAPI 
*/
Napi::Object _SrtOpusOutput::Init(Napi::Env env, Napi::Object exports) {
    // This method is used to hook the accessor and method callbacks
    Napi::Function func = DefineClass(env, "_SrtOpusOutput", {
        InstanceMethod("Start", &_SrtOpusOutput::Start),
        InstanceMethod("Stop", &_SrtOpusOutput::Stop),
        InstanceMethod("SetDevice", &_SrtOpusOutput::SetDevice),
        InstanceMethod("SetPALatency", &_SrtOpusOutput::SetPALatency),
        InstanceMethod("SetSampleRate", &_SrtOpusOutput::SetSampleRate),
        InstanceMethod("SetBitDepth", &_SrtOpusOutput::SetBitDepth),
        InstanceMethod("SetChannels", &_SrtOpusOutput::SetChannels),
        InstanceMethod("SetBitrate", &_SrtOpusOutput::SetBitrate),
        InstanceMethod("SetUri", &_SrtOpusOutput::SetUri)
    });

    // Create a peristent reference to the class constructor. This will allow
    // a function called on a class prototype and a function
    // called on instance of a class to be distinguished from each other.
    constructor = Napi::Persistent(func);
    // Call the SuppressDestruct() method on the static data prevent the calling
    // to this destructor to reset the reference when the environment is no longer
    // available.
    constructor.SuppressDestruct();
    exports.Set("_SrtOpusOutput", func);
    return exports;
}

// ====================================
// Constructor 
// ====================================
/**
 * [0] - _device - Pulse audio device - default: null
 * [1] - _paLatency - Palse audio latency (ms) - default: 50
 * [2] - _sampleRate - Sample rate - default: 48000
 * [3] - _bitDepth - default: 16
 * [4] - _channels - Channel amount - default: 2
 * [5] - _bitrate - stream bitrate - default: 64000
 * [6] - _uri - Srt url - default: null
*/
_SrtOpusOutput::_SrtOpusOutput(const Napi::CallbackInfo &info) : Napi::ObjectWrap<_SrtOpusOutput>(info) {
    int len = info.Length();

    if (len >= 1 && info[0].IsString() ) { this->_device = info[0].As<Napi::String>().Utf8Value(); } else { std::cout <<  Napi::String::New(info.Env(), "_device not supplied or invalid type\n"); };
    if (len >= 2 && info[1].IsNumber() ) { this->_paLatency = info[1].As<Napi::Number>(); } else { std::cout <<  Napi::String::New(info.Env(), "_paLatency not supplied or invalid type\n"); };
    if (len >= 3 && info[2].IsNumber() ) { this->_sampleRate = info[2].As<Napi::Number>(); } else { std::cout <<  Napi::String::New(info.Env(), "_sampleRate not supplied or invalid type\n"); };
    if (len >= 4 && info[3].IsString() ) { this->_bitDepth = "S" + info[3].As<Napi::String>().Utf8Value() + "LE"; } else { std::cout <<  Napi::String::New(info.Env(), "_bitDepth not supplied or invalid type\n"); };
    if (len >= 5 && info[4].IsNumber() ) { this->_channels = info[4].As<Napi::Number>(); } else { std::cout <<  Napi::String::New(info.Env(), "_channels not supplied or invalid type\n"); };
    if (len >= 6 && info[5].IsNumber() ) { this->_bitrate = info[5].As<Napi::Number>(); } else { std::cout <<  Napi::String::New(info.Env(), "_bitrate not supplied or invalid type\n"); };
    if (len >= 7 && info[6].IsString() ) { this->_uri = info[6].As<Napi::String>().Utf8Value(); } else { std::cout <<  Napi::String::New(info.Env(), "_uri not supplied or invalid type\n"); };
}

Napi::FunctionReference _SrtOpusOutput::constructor;

// ====================================
// _SrtOpusOutput Class 
// ====================================

Napi::Value _SrtOpusOutput::Start(const Napi::CallbackInfo &info){

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

Napi::Value _SrtOpusOutput::Stop(const Napi::CallbackInfo &info){
    // Stop pipeline
    g_main_loop_quit(this->loop);
    return Napi::String::New(info.Env(), "Pipline stopped");
}

// --------
// Setters
// --------
/**
 * [0] - _device - Pulse audio device - default: null
*/
Napi::Value _SrtOpusOutput::SetDevice(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { this->_device = info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "_device not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _paLatency - Palse audio latency (ms) - default: 50
*/
Napi::Value _SrtOpusOutput::SetPALatency(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsNumber() ) { this->_paLatency = info[0].As<Napi::Number>(); } else { return Napi::String::New(info.Env(), "_paLatency not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _sampleRate - Sample rate - default: 48000
*/
Napi::Value _SrtOpusOutput::SetSampleRate(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsNumber() ) { this->_sampleRate = info[0].As<Napi::Number>(); } else { return Napi::String::New(info.Env(), "_sampleRate not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _bitDepth - default: 16
*/
Napi::Value _SrtOpusOutput::SetBitDepth(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { this->_bitDepth = "S" + info[0].As<Napi::String>().Utf8Value() + "LE"; } else { return Napi::String::New(info.Env(), "_bitDepth not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _channels - Channel amount - default: 2
*/
Napi::Value _SrtOpusOutput::SetChannels(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsNumber() ) { this->_channels = info[0].As<Napi::Number>(); } else { return Napi::String::New(info.Env(), "_channels not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _bitrate - stream bitrate - default: 64000
*/
Napi::Value _SrtOpusOutput::SetBitrate(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsNumber() ) { this->_bitrate = info[0].As<Napi::Number>(); } else { return Napi::String::New(info.Env(), "_bitrate not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _uri - Srt url - default: null
*/
Napi::Value _SrtOpusOutput::SetUri(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { this->_uri = info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "_uri not supplied or invalid type\n"); };
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
    // test class and class type before entering to avoid function crashing due to invalid class
    _SrtOpusOutput *obj = static_cast<_SrtOpusOutput *>(data);
    if (data != nullptr && obj) {
        try {
            switch (GST_MESSAGE_TYPE (message)) {
                case GST_MESSAGE_ERROR:{
                    std::string errorMessage;
                    GError *err;
                    gchar *debug;
                    gst_message_parse_error (message, &err, &debug);
                    g_print ("Error: %s\n", err->message);
                    
                    obj->_emit.NonBlockingCall([err](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, g_strdup(err->message)); });
                    obj->_emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "ERROR | Reloading pipline"); });

                    // Reload pipeline on stream error (This is that the srt keep's trying to reconnect, when an stream error occurs)
                    gst_element_set_state(obj->pipeline, GST_STATE_NULL);
                    gst_element_set_state (obj->pipeline, GST_STATE_PLAYING);

                    g_error_free (err);
                    g_free (debug);

                    break;
                }
                case GST_MESSAGE_EOS:{
                    /* end-of-stream */
                    obj->_emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "EOS | Reloading pipline"); });
                    
                    // restarting on EOS
                    gst_element_set_state(obj->pipeline, GST_STATE_NULL);
                    gst_element_set_state (obj->pipeline, GST_STATE_PLAYING);
                    break;
                }
                default:
                    break;
            }
        } catch (std::logic_error& e) {
            std::cout << "logic_error thrown" << std::endl;
        }
    } else {
        std::cout << "Invalid class reference " << std::endl;
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
void _SrtOpusOutput::th_Start() {
    try {
        this->_emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Pipeline started"); });
        /* Varaibles */
        // Gstreamer
        GstBus *bus;
        GstPad *srcpad;

        /* Initialize GStreamer */
        gst_init (NULL, NULL);
        this->loop = g_main_loop_new (NULL, FALSE);

        /* ------------------------------ Prep pipeline -------------------------------- */

        /* Create the elements */
        gl.source = gst_element_factory_make ("pulsesrc", "source");
        gl.audioresample = gst_element_factory_make ("audioresample", "audioresample");
        gl.audioconvert = gst_element_factory_make ("audioconvert", "audioconvert");
        gl.a_convert_queue = gst_element_factory_make ("queue", "a_convert_queue");
        gl.opusenc = gst_element_factory_make ("opusenc", "opusenc");
        gl.mpegtsmux = gst_element_factory_make ("mpegtsmux", "mpegtsmux");
        gl.srtsink = gst_element_factory_make ("srtserversink", "srtsink");

        /* Create the empty pipeline */
        this->pipeline = gst_pipeline_new ("pipeline");

        if (!this->pipeline || !gl.source || !gl.audioconvert ||
            !gl.audioresample || !gl.a_convert_queue || !gl.opusenc || !gl.mpegtsmux || !gl.srtsink) { 
            g_printerr ("Not all elements could be created.\n");
        }

        /* Configure elements */
        // src
        g_object_set (gl.source, "device", this->_device.c_str(), NULL);
        g_object_set (gl.source, "buffer-time", (guint64)this->_paLatency * 1000, NULL); // value need to be cast to guint64 (https://gstreamer-devel.narkive.com/wr5HjCpX/gst-devel-how-to-set-max-size-time-property-of-queue)
        g_object_set (gl.opusenc, "bitrate", (guint64)this->_bitrate * 1000, NULL);   
        g_object_set (gl.opusenc, "audio-type", 2051, NULL);    
        g_object_set (gl.opusenc, "bitrate-type", 2, NULL);  
        g_object_set (gl.mpegtsmux, "latency", (guint64)1, NULL);   
        g_object_set (gl.srtsink, "wait-for-connection", false, NULL);  
        g_object_set (gl.srtsink, "sync", false, NULL);  
        g_object_set (gl.srtsink, "uri", this->_uri.c_str(), NULL);   
        // queue's
        g_object_set (gl.a_convert_queue, "leaky", 1, NULL);
        g_object_set (gl.a_convert_queue, "max-size-time", (guint64)100000000, NULL); // value need to be cast to guint64 (https://gstreamer-devel.narkive.com/wr5HjCpX/gst-devel-how-to-set-max-size-time-property-of-queue)

        /* Link all elements that can be automatically linked because they have "Always" pads */
        gst_bin_add_many (GST_BIN (this->pipeline), gl.source, gl.audioconvert,
            gl.audioresample, gl.a_convert_queue, gl.opusenc, gl.mpegtsmux, gl.srtsink, NULL);

        // /* Linking */
        if (// src
            gst_element_link_many (gl.source, gl.audioconvert, gl.audioresample, gl.a_convert_queue, gl.opusenc, gl.mpegtsmux, gl.srtsink, NULL) != TRUE) {
            g_printerr ("Elements could not be linked.\n");
            gst_object_unref (this->pipeline); 
        }

        /* Link caps */
        gl.caps = gst_caps_new_simple("audio/x-raw",
            "format", G_TYPE_STRING, this->_bitDepth.c_str(),
            "rate", G_TYPE_INT, this->_sampleRate,
            "channels", G_TYPE_INT, this->_channels,
            NULL);
        srcpad = gst_element_get_static_pad(gl.source, "src");
        gst_pad_set_caps(srcpad, gl.caps);
        gst_caps_unref(gl.caps);

        /* ------------------------------ Prep pipeline -------------------------------- */

        /* Start playing the pipeline */
        gst_element_set_state (this->pipeline, GST_STATE_PLAYING);

        /* Wait until error or EOS */
        bus = gst_element_get_bus (this->pipeline);
        gst_bus_add_signal_watch(bus);
        g_signal_connect(bus, "message", G_CALLBACK(my_bus_callback), this);
        // gst_bus_add_watch (bus, my_bus_callback, this);
        gst_object_unref (bus);

        g_main_loop_run (this->loop);

        /* ------------------------------- Post cleanup -------------------------------- */
        this->_emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Pipeline stopped"); });

        gst_element_set_state(this->pipeline, GST_STATE_NULL);
        gst_object_unref (this->pipeline);
        g_main_loop_unref (this->loop);

        this->_emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Resource cleanup complete"); });
        /* ------------------------------- Post cleanup -------------------------------- */
    } catch (std::logic_error& e) {
        std::cout << "logic_error thrown" << std::endl;
    }
}
