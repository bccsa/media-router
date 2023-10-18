#include <napi.h>
#include <gst/gst.h>
#include <gtk/gtk.h>
#include <gdk/gdkx.h>
#include <thread>
#include <iostream>
#include <gst/video/videooverlay.h>

/* Structure to contain all our information, so we can pass it to callbacks */
typedef struct _CustomData {
    // src
    GstElement *source;
    GstElement *tee;
    // audio
    GstElement *audio_queue;
    GstElement *a_tsparser;
    GstElement *a_demuxer;
    GstElement *aacparse;
    GstElement *avdec_aac;
    GstElement *audioconvert;
    GstCaps *audiocap;
    GstElement *a_convert_queue;
    GstElement *audiosink;
    // video
    GstElement *video_queue;
    GstElement *v_tsparser;
    GstElement *v_demuxer;
    GstElement *h264parser;
    GstElement *decoder;
    GstElement *decode_queue;
    GstElement *videoconvert;
    GstElement *v_convert_queue;
    GstElement *videosink;
} CustomData;

// Variables
std::string _uri = "null";
std::string _pulseSink = "null";
int _paLatency = 50;
std::string _display = "null";
gboolean _fullScreen = false;
// Global window 
GtkWidget *_window;

// ====================================
// Helper functions 
// ====================================

/**
 * Callback messages from bus
*/
static gboolean my_bus_callback (GstBus * bus, GstMessage * message, gpointer data)
{
    // g_print ("Got %s message\n", GST_MESSAGE_TYPE_NAME (message));

    switch (GST_MESSAGE_TYPE (message)) {
        case GST_MESSAGE_ERROR:{
        GError *err;
        gchar *debug;

        gst_message_parse_error (message, &err, &debug);
        g_print ("Error: %s\n", err->message);
        g_error_free (err);
        g_free (debug);

        break;
        }
        case GST_MESSAGE_EOS:
        /* end-of-stream */
        break;
        default:
        /* unhandled message */
        break;
    }

    /* we want to be notified again the next time there is a message
    * on the bus, so returning TRUE (FALSE means we want to stop watching
    * for messages on the bus and our callback should not be called again)
    */
    return TRUE;
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
/**
 * Create a tee pad
*/
static GstPad* create_tee_pad (GstElement *src_elm, GstElement *sink_elm, GstElement *pipeline)
{
    GstPad *src_pad, *sink_pad;

    /* link pads */
    src_pad = gst_element_get_request_pad(src_elm, "src_%u");
    g_print("Obtained request pad %s.\n", gst_pad_get_name (src_pad));
    sink_pad = gst_element_get_static_pad(sink_elm, "sink");

    if (gst_pad_link(src_pad, sink_pad) != GST_PAD_LINK_OK) {
        g_printerr("Tee could not be linked.\n");
        gst_object_unref(pipeline);
        return NULL;
    }
    gst_object_unref(sink_pad);

    return src_pad;
}

// ====================================
// Gtk Window Functions
// ====================================

/**
 * Destroy gtk window
*/
static void destroyWindow(GtkWidget *widget, gpointer data) {
    gtk_main_quit();
}

/**
 * Double click event
*/
static gboolean doubleClick(GtkWidget *widget, GdkEventButton *event, gpointer user_data) {
    GdkWindowState state = gdk_window_get_state(gtk_widget_get_window(_window));
    // Check for a double-click
    if (event->type == GDK_2BUTTON_PRESS && event->button == 1) {
        if (state & GDK_WINDOW_STATE_FULLSCREEN) {
            gtk_window_unfullscreen(GTK_WINDOW(_window));
        } else {
            gtk_window_fullscreen(GTK_WINDOW(_window));
        }
    }
    return TRUE;
}

// ====================================
// Start Gstreamer
// ====================================

/**
 * Start Gstreamer in a seperate thread
*/
void th_Start() {
    /* Varaibles */
    CustomData gl;
    // Gstreamer
    GstPad *tee_audio_pad, *tee_video_pad;
    GstElement *pipeline;
    GstBus *bus;
    // gdk window
    GdkWindow *video_window_xwindow;
    GtkWidget *video_window;
    gulong embed_xid;
    g_setenv("DISPLAY", _display.c_str(), TRUE);

    /* Initialize GStreamer */
    gst_init (NULL, NULL);
    gtk_init (NULL, NULL);
    /* ------------------------------ prepare the ui -------------------------------- */
    // Winodw needs to be created in the before the pipline, otherwise on a busy device it will fail 
    _window = gtk_window_new (GTK_WINDOW_TOPLEVEL); 
    
    g_signal_connect(_window, "delete-event", G_CALLBACK(destroyWindow), NULL);
    g_signal_connect(_window, "destroy", G_CALLBACK(destroyWindow), NULL);
    gtk_window_set_default_size (GTK_WINDOW (_window), 640, 360);
    g_signal_connect(_window, "button-press-event", G_CALLBACK(doubleClick), NULL);
    gtk_window_set_title (GTK_WINDOW (_window), "Video Over SRT Input");
    // full screen window 
    if(_fullScreen) {
        gtk_window_fullscreen(GTK_WINDOW(_window));
    } else {
        gtk_window_unfullscreen(GTK_WINDOW(_window));
    }

    video_window = gtk_drawing_area_new ();
    gtk_container_add (GTK_CONTAINER (_window), video_window);

    gtk_widget_show_all (_window);

    video_window_xwindow = gtk_widget_get_window (video_window);
    embed_xid = GDK_WINDOW_XID (video_window_xwindow);
    /* ------------------------------ prepare the ui -------------------------------- */

    /* ------------------------------ Prep pipline -------------------------------- */

    /* Create the elements */
    // src
    gl.source = gst_element_factory_make ("srtsrc", "source");
    gl.tee = gst_element_factory_make ("tee", "tee");
    // audio
    gl.audio_queue = gst_element_factory_make ("queue", "audio_queue");
    gl.a_tsparser = gst_element_factory_make ("tsparse", "a_tsparser");
    gl.a_demuxer = gst_element_factory_make ("tsdemux", "a_demuxer");
    gl.aacparse = gst_element_factory_make ("aacparse", "aacparse");
    gl.avdec_aac = gst_element_factory_make ("avdec_aac", "avdec_aac");
    gl.audioconvert = gst_element_factory_make ("audioconvert", "audioconvert");
    // gl.audiocap = gst_caps_new_simple ("audio/x-raw");
    gl.a_convert_queue = gst_element_factory_make ("queue", "a_convert_queue");
    gl.audiosink = gst_element_factory_make ("pulsesink", "audiosink");
    // video
    gl.video_queue = gst_element_factory_make ("queue", "video_queue");
    gl.v_tsparser = gst_element_factory_make ("tsparse", "v_tsparser");
    gl.v_demuxer = gst_element_factory_make ("tsdemux", "v_demuxer");
    gl.h264parser = gst_element_factory_make ("h264parse", "h264parser");
    gl.decoder = gst_element_factory_make ("v4l2h264dec", "decoder");
    gl.decode_queue = gst_element_factory_make ("queue", "decode_queue");
    gl.videoconvert = gst_element_factory_make ("videoconvert", "videoconvert");
    gl.v_convert_queue = gst_element_factory_make ("queue", "v_convert_queue");
    gl.videosink = gst_element_factory_make ("xvimagesink", "videosink");

    /* Create the empty pipeline */
    pipeline = gst_pipeline_new ("pipeline");

    if (!pipeline || !gl.source || !gl.tee ||                                                                                                                                        // src
        !gl.audio_queue || !gl.a_tsparser || !gl.a_demuxer || !gl.aacparse || !gl.avdec_aac || !gl.audioconvert || !gl.a_convert_queue || !gl.audiosink ||                          // audio
        !gl.video_queue || !gl.v_tsparser || !gl.v_demuxer || !gl.h264parser || !gl.decoder || !gl.decode_queue || !gl.videoconvert || !gl.v_convert_queue || !gl.videosink) {      // video
        g_printerr ("Not all elements could be created.\n");
    }

    /* Configure elements */
    // src
    g_object_set (gl.source, "uri", _uri.c_str(), NULL);
    g_object_set (gl.source, "wait-for-connection", false, NULL);
    // audio
    g_object_set (gl.a_demuxer, "latency", 1, NULL);
    g_object_set (gl.audiosink, "device", _pulseSink.c_str(), NULL);
    g_object_set (gl.audiosink, "latency-time", _paLatency * 1000, NULL);
    // video
    g_object_set (gl.v_demuxer, "latency", 1, NULL);
    g_object_set (gl.decoder, "capture-io-mode", 4, NULL);
    g_object_set (gl.videosink, "display", _display.c_str(), NULL);     // Set ouput display                                   

    /* Link all elements that can be automatically linked because they have "Always" pads */
    gst_bin_add_many (GST_BIN (pipeline), gl.source, gl.tee,                                        // src
        gl.audio_queue, gl.a_tsparser, gl.a_demuxer, gl.aacparse, gl.avdec_aac, gl.audioconvert, gl.a_convert_queue, gl.audiosink,                               // audio
        gl.video_queue, gl.v_tsparser, gl.v_demuxer, gl.h264parser, gl.decoder, gl.decode_queue, gl.videoconvert, gl.v_convert_queue, gl.videosink,              // video
        NULL);

    /* Linking */
    if (// src
        gst_element_link_many (gl.source, gl.tee, NULL) != TRUE ||
        // audio
        gst_element_link_many (gl.audio_queue, gl.a_tsparser, gl.a_demuxer, NULL) != TRUE ||  
        gst_element_link_many (gl.aacparse, gl.avdec_aac, gl.audioconvert, gl.a_convert_queue, gl.audiosink, NULL) != TRUE ||
        // video
        gst_element_link_many (gl.video_queue, gl.v_tsparser, gl.v_demuxer, NULL) != TRUE ||
        gst_element_link_many (gl.h264parser, gl.decoder, gl.decode_queue, gl.videoconvert, gl.videosink, NULL) != TRUE 
        ) {
        g_printerr ("Elements could not be linked.\n");
        gst_object_unref (pipeline); 
    }

    /* add pad */
    g_signal_connect (gl.a_demuxer, "pad-added", G_CALLBACK (on_pad_added), gl.aacparse);
    g_signal_connect (gl.v_demuxer, "pad-added", G_CALLBACK (on_pad_added), gl.h264parser);
    tee_audio_pad = create_tee_pad(gl.tee, gl.audio_queue, pipeline);
    tee_video_pad = create_tee_pad(gl.tee, gl.video_queue, pipeline);

    // connect source to tee 
    g_signal_connect (gl.source, "pad-added", G_CALLBACK (on_pad_added), gl.tee);

    /* ------------------------------ Prep pipline -------------------------------- */

    /* -------------------------------_Link the ui -------------------------------- */
    gst_video_overlay_set_window_handle (GST_VIDEO_OVERLAY (gl.videosink), embed_xid);
    
    /* ------------------------------- Link the ui -------------------------------- */

    /* Start playing the pipeline */
    gst_element_set_state (pipeline, GST_STATE_PLAYING);

    /* Wait until error or EOS */
    bus = gst_element_get_bus (pipeline);

    gst_bus_add_watch (bus, my_bus_callback, NULL);
    gst_object_unref (bus);

    gtk_main ();

    gst_element_set_state(pipeline, GST_STATE_NULL);
    /* Release the request pads from the Tee, and unref them */
    gst_element_release_request_pad (gl.tee, tee_audio_pad);
    gst_element_release_request_pad (gl.tee, tee_video_pad);
    gst_object_unref (tee_audio_pad);
    gst_object_unref (tee_video_pad);

    /* Free resources */
    gst_object_unref (pipeline);
    g_object_unref (video_window_xwindow);
}

// ====================================
// Init 
// ====================================
class _SrtVideoInput : public Napi::ObjectWrap<_SrtVideoInput> {
    public:
        static Napi::Object Init(Napi::Env env, Napi::Object exports);
        _SrtVideoInput(const Napi::CallbackInfo &info);

    private:
        // Gstreamer Functions
        static Napi::FunctionReference constructor;
        Napi::Value Start(const Napi::CallbackInfo &info);
        Napi::Value Stop(const Napi::CallbackInfo &info);
        // Setters
        Napi::Value SetUri(const Napi::CallbackInfo &info);
        Napi::Value SetSink(const Napi::CallbackInfo &info);
        Napi::Value SetPALatency(const Napi::CallbackInfo &info);
        Napi::Value SetDisplay(const Napi::CallbackInfo &info);
        Napi::Value SetFullscreen(const Napi::CallbackInfo &info);
};

/**
 * Link Class to NAPI 
*/
Napi::Object _SrtVideoInput::Init(Napi::Env env, Napi::Object exports) {
    // This method is used to hook the accessor and method callbacks
    Napi::Function func = DefineClass(env, "_SrtVideoInput", {
        InstanceMethod("Start", &_SrtVideoInput::Start),
        InstanceMethod("Stop", &_SrtVideoInput::Stop),
        InstanceMethod("SetUri", &_SrtVideoInput::SetUri),
        InstanceMethod("SetSink", &_SrtVideoInput::SetSink),
        InstanceMethod("SetPALatency", &_SrtVideoInput::SetPALatency),
        InstanceMethod("SetDisplay", &_SrtVideoInput::SetDisplay),
        InstanceMethod("SetFullscreen", &_SrtVideoInput::SetFullscreen)
    });

    // Create a peristent reference to the class constructor. This will allow
    // a function called on a class prototype and a function
    // called on instance of a class to be distinguished from each other.
    constructor = Napi::Persistent(func);
    // Call the SuppressDestruct() method on the static data prevent the calling
    // to this destructor to reset the reference when the environment is no longer
    // available.
    constructor.SuppressDestruct();
    exports.Set("_SrtVideoInput", func);
    return exports;
}

// ====================================
// Constructor 
// ====================================
/**
 * [1] - _uri - Srt url - default: null
 * [2] - _pulseSink - Pulse audio sink - default: null
 * [3] - _paLatency - Palse audio latency (ms) - default: 50
 * [4] - _display - Output dispaly - default: 0
 * [5] - _fullScreen - full screen mode - default: false
*/
_SrtVideoInput::_SrtVideoInput(const Napi::CallbackInfo &info) : Napi::ObjectWrap<_SrtVideoInput>(info) {
    int len = info.Length();

    if (len >= 1 && info[0].IsString() ) { _uri = info[0].As<Napi::String>().Utf8Value(); } else { std::cout << "_uri not supplied or invalid type\n"; };
    if (len >= 2 && info[1].IsString() ) { _pulseSink = info[1].As<Napi::String>().Utf8Value(); } else { std::cout << "_pulseSink not supplied or invalid type\n"; };
    if (len >= 3 && info[2].IsNumber() ) { _paLatency = info[2].As<Napi::Number>(); } else { std::cout << "_paLatency not supplied or invalid type\n"; };
    if (len >= 4 && info[3].IsString() ) { _display = ":" + info[3].As<Napi::String>().Utf8Value(); } else { std::cout << "_display not supplied or invalid type\n"; };
    if (len >= 5 && info[4].IsBoolean() ) { _fullScreen = info[4].As<Napi::Boolean>(); } else { std::cout << "_fullScreen not supplied or invalid type\n"; };
}

Napi::FunctionReference _SrtVideoInput::constructor;

// ====================================
// _SrtVideoInput Class 
// ====================================

Napi::Value _SrtVideoInput::Start(const Napi::CallbackInfo &info){

    std::thread t1(th_Start);
    t1.detach();

    return Napi::String::New(info.Env(), "Pipline started");
}

Napi::Value _SrtVideoInput::Stop(const Napi::CallbackInfo &info){
    // Kill window
    gtk_widget_destroy(_window);

    return Napi::String::New(info.Env(), "Pipline stopped");
}

// --------
// Setters
// --------
/**
 * [0] - _uri - Srt url - default: null
*/
Napi::Value _SrtVideoInput::SetUri(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { _uri = info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "_uri not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _pulseSink - Pulse audio sink - default: null
*/
Napi::Value _SrtVideoInput::SetSink(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { _pulseSink = info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "_pulseSink not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _paLatency - Palse audio latency (ms) - default: 50
*/
Napi::Value _SrtVideoInput::SetPALatency(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsNumber() ) { _paLatency = info[0].As<Napi::Number>(); } else { return Napi::String::New(info.Env(), "_paLatency not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _display - Output dispaly - default: 0
*/
Napi::Value _SrtVideoInput::SetDisplay(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { _display = ":" + info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "_display not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _fullScreen - full screen mode - default: false
*/
Napi::Value _SrtVideoInput::SetFullscreen(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsBoolean() ) { _fullScreen = info[0].As<Napi::Boolean>(); } else { return Napi::String::New(info.Env(), "_fullScreen not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}