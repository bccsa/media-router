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
    GstElement *tsdemux;
    // audio
    GstElement *audio_queue;
    GstElement *aacparse;
    GstElement *avdec_aac;
    GstElement *audioconvert;
    GstElement *a_convert_queue;
    GstElement *audiosink;
    // video
    GstElement *video_queue;
    GstElement *h264parser;
    GstElement *decoder;
    GstElement *decode_queue;
    GstElement *videoconvert;
    GstElement *v_convert_queue;
    GstElement *videosink;
} CustomData;

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
class _SrtVideoPlayer : public Napi::ObjectWrap<_SrtVideoPlayer> {
    public:
        static Napi::Object Init(Napi::Env env, Napi::Object exports);
        gboolean _w = false;
        _SrtVideoPlayer(const Napi::CallbackInfo &info);
        void th_Start();
        // Variables
        std::string _name = "SrtVideoPlayer";
        std::string _uri = "null";
        std::string _pulseSink = "null";
        int _paLatency = 50;
        std::string _display = "null";
        gboolean _fullScreen = false;
        GstElement *pipeline;
        // Process varialbes 
        gboolean running = false;   // Gstreamer running state
        gboolean killing = false;   // Gstreamer killing state
        // gdk window
        gulong embed_xid;
        // Global window 
        GtkWidget *_window;
        GdkWindow *video_window_xwindow;

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
        Napi::Value SetName(const Napi::CallbackInfo &info);
};

/**
 * Link Class to NAPI 
*/
Napi::Object _SrtVideoPlayer::Init(Napi::Env env, Napi::Object exports) {
    // This method is used to hook the accessor and method callbacks
    Napi::Function func = DefineClass(env, "_SrtVideoPlayer", {
        InstanceMethod("Start", &_SrtVideoPlayer::Start),
        InstanceMethod("Stop", &_SrtVideoPlayer::Stop),
        InstanceMethod("SetUri", &_SrtVideoPlayer::SetUri),
        InstanceMethod("SetSink", &_SrtVideoPlayer::SetSink),
        InstanceMethod("SetPALatency", &_SrtVideoPlayer::SetPALatency),
        InstanceMethod("SetDisplay", &_SrtVideoPlayer::SetDisplay),
        InstanceMethod("SetFullscreen", &_SrtVideoPlayer::SetFullscreen),
        InstanceMethod("SetName", &_SrtVideoPlayer::SetFullscreen)
    });

    // Create a peristent reference to the class constructor. This will allow
    // a function called on a class prototype and a function
    // called on instance of a class to be distinguished from each other.
    constructor = Napi::Persistent(func);
    // Call the SuppressDestruct() method on the static data prevent the calling
    // to this destructor to reset the reference when the environment is no longer
    // available.
    constructor.SuppressDestruct();
    exports.Set("_SrtVideoPlayer", func);
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
 * [6] - _name - Player Name - default: SrtVideoPlayer
*/
_SrtVideoPlayer::_SrtVideoPlayer(const Napi::CallbackInfo &info) : Napi::ObjectWrap<_SrtVideoPlayer>(info) {
    int len = info.Length();

    if (len >= 1 && info[0].IsString() ) { this->_uri = info[0].As<Napi::String>().Utf8Value(); } else { std::cout << "_uri not supplied or invalid type\n"; };
    if (len >= 2 && info[1].IsString() ) { this->_pulseSink = info[1].As<Napi::String>().Utf8Value(); } else { std::cout << "_pulseSink not supplied or invalid type\n"; };
    if (len >= 3 && info[2].IsNumber() ) { this->_paLatency = info[2].As<Napi::Number>(); } else { std::cout << "_paLatency not supplied or invalid type\n"; };
    if (len >= 4 && info[3].IsString() ) { this->_display = ":" + info[3].As<Napi::String>().Utf8Value(); } else { std::cout << "_display not supplied or invalid type\n"; };
    if (len >= 5 && info[4].IsBoolean() ) { this->_fullScreen = info[4].As<Napi::Boolean>(); } else { std::cout << "_fullScreen not supplied or invalid type\n"; };
    if (len >= 6 && info[5].IsString() ) { this->_name = info[5].As<Napi::String>().Utf8Value(); } else { std::cout << "Player name not supplied or invalid type\n"; };
}

Napi::FunctionReference _SrtVideoPlayer::constructor;

// ====================================
// Gtk Window Functions
// ====================================

/**
 * Destroy gtk window (see: for intersepting event: https://stackoverflow.com/questions/34387757/how-do-i-intercept-a-gtk-window-close-button-click)
*/
gboolean destroyWindow(GtkWidget *widget, gpointer data) {
    _SrtVideoPlayer *obj = static_cast<_SrtVideoPlayer *>(data);
    gtk_widget_hide(obj->_window); // Need to hide window instead of destroy, otherwise gtk_main_quit will fail sometimes https://stackoverflow.com/questions/30521811/gtk-main-blocking-others-threads-how-to-solve
    obj->killing = true;
    gtk_main_quit();
    return TRUE; // Return true inorder for gtk not to continue to destroy the window https://stackoverflow.com/questions/34387757/how-do-i-intercept-a-gtk-window-close-button-click
}

/**
 * Double click event
*/
static gboolean doubleClick(GtkWidget *widget, GdkEventButton *event, gpointer data) {
    _SrtVideoPlayer *obj = static_cast<_SrtVideoPlayer *>(data);
    GdkWindowState state = gdk_window_get_state(gtk_widget_get_window(obj->_window));
    // Check for a double-click
    if (event->type == GDK_2BUTTON_PRESS && event->button == 1) {
        if (state & GDK_WINDOW_STATE_FULLSCREEN) {
            gtk_window_unfullscreen(GTK_WINDOW(obj->_window));
        } else {
            gtk_window_fullscreen(GTK_WINDOW(obj->_window));
        }
    }
    return TRUE;
}

// ====================================
// Gstreamer message bus
// ====================================

/**
 * Callback messages from bus
*/
static gboolean my_bus_callback (GstBus * bus, GstMessage * message, gpointer data)
{
    _SrtVideoPlayer *obj = (_SrtVideoPlayer *) data;
    switch (GST_MESSAGE_TYPE (message)) {
        case GST_MESSAGE_ERROR:{
            std::string errorMessage;
            GError *err;
            gchar *debug;
            gst_message_parse_error (message, &err, &debug);
            g_print ("Error: %s\n", err->message);
        
            // https://chat.openai.com/share/6654604b-6271-4b02-a84e-6d72fe9a5a25
            _emit.NonBlockingCall([err](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, g_strdup(err->message)); });

            g_error_free (err);
            g_free (debug);

            // restarting pipeline
            gst_element_set_state(obj->pipeline, GST_STATE_NULL);
            gst_element_set_state (obj->pipeline, GST_STATE_PLAYING);
            
            _emit.NonBlockingCall([err](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Restarting pipeline due to a fatal error"); });

            break;
        }
        case GST_MESSAGE_EOS: {
            /* end-of-stream */
            gst_element_set_state(obj->pipeline, GST_STATE_NULL);
            gst_element_set_state (obj->pipeline, GST_STATE_PLAYING);

            _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "EOS"); });
            break;
        }
        default:
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

// ====================================
// Start Gstreamer
// ====================================

/**
 * Start Gstreamer in a seperate thread
*/
void _SrtVideoPlayer::th_Start() {
    _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Pipeline started"); });
    /* Varaibles */
    CustomData gl;
    // Gstreamer
    GstBus *bus;
    g_setenv("DISPLAY", _display.c_str(), TRUE);

    /* Initialize GStreamer */
    gst_init (NULL, NULL);
    gtk_init_check (NULL, NULL);

    /* ------------------------------ prepare the ui -------------------------------- */ // (https://zetcode.com/gui/gtk2/firstprograms/)
    // Winodw needs to be created in the before the pipline, otherwise on a busy device it will fail 
    this->_window = gtk_window_new (GTK_WINDOW_TOPLEVEL); 
    g_signal_connect(this->_window, "delete-event", G_CALLBACK(destroyWindow), this);
    g_signal_connect(this->_window, "button-press-event", G_CALLBACK(doubleClick), this);
    gtk_window_set_default_size (GTK_WINDOW (this->_window), 640, 360);
    gtk_window_set_title (GTK_WINDOW (this->_window), this->_name.c_str());
    // full screen window 
    if(this->_fullScreen) {
        gtk_window_fullscreen(GTK_WINDOW(this->_window));
    } else {
        gtk_window_unfullscreen(GTK_WINDOW(this->_window));
    }

    gtk_widget_show(this->_window);

    this->video_window_xwindow = gtk_widget_get_window (this->_window);
    this->embed_xid = GDK_WINDOW_XID (this->video_window_xwindow);    
    /* ------------------------------ prepare the ui -------------------------------- */

    /* ------------------------------ Prep pipline -------------------------------- */

    /* Create the elements */
    // src
    gl.source = gst_element_factory_make ("srtsrc", "source");
    gl.tsdemux = gst_element_factory_make ("tsdemux", "tsdemux");
    // audio
    gl.audio_queue = gst_element_factory_make ("queue", "audio_queue");
    gl.aacparse = gst_element_factory_make ("aacparse", "aacparse");
    gl.avdec_aac = gst_element_factory_make ("avdec_aac", "avdec_aac");
    gl.audioconvert = gst_element_factory_make ("audioconvert", "audioconvert");
    gl.a_convert_queue = gst_element_factory_make ("queue", "a_convert_queue");
    gl.audiosink = gst_element_factory_make ("pulsesink", "audiosink");
    // video
    gl.video_queue = gst_element_factory_make ("queue", "video_queue");
    gl.h264parser = gst_element_factory_make ("h264parse", "h264parser");
    gl.decoder = gst_element_factory_make ("v4l2h264dec", "decoder");
    gl.decode_queue = gst_element_factory_make ("queue", "decode_queue");
    gl.videoconvert = gst_element_factory_make ("videoconvert", "videoconvert");
    gl.v_convert_queue = gst_element_factory_make ("queue", "v_convert_queue");
    gl.videosink = gst_element_factory_make ("xvimagesink", "videosink");

    /* Create the empty pipeline */
    this->pipeline = gst_pipeline_new ("pipeline");

    if (!this->pipeline || !gl.source || !gl.tsdemux ||                                                                                                                                        // src
        !gl.audio_queue || !gl.aacparse || !gl.avdec_aac || !gl.audioconvert || !gl.a_convert_queue || !gl.audiosink ||                          // audio
        !gl.video_queue || !gl.h264parser || !gl.decoder || !gl.decode_queue || !gl.videoconvert || !gl.v_convert_queue || !gl.videosink) {      // video
        g_printerr ("Not all elements could be created.\n");
    }

    /* Configure elements */
    // src
    g_object_set (gl.source, "uri", this->_uri.c_str(), NULL);
    g_object_set (gl.source, "wait-for-connection", false, NULL);
    g_object_set (gl.tsdemux, "latency", 1, NULL);
    g_object_set (gl.tsdemux, "ignore-pcr", true, NULL);
    // audio
    g_object_set (gl.audiosink, "device", this->_pulseSink.c_str(), NULL);
    g_object_set (gl.audiosink, "latency-time", this->_paLatency * 1000, NULL);
    // video
    g_object_set (gl.decoder, "capture-io-mode", 4, NULL);
    g_object_set (gl.videosink, "display", this->_display.c_str(), NULL);     // Set ouput display      
    // queue's
    g_object_set (gl.audio_queue, "leaky", 2, NULL);
    g_object_set (gl.a_convert_queue, "leaky", 2, NULL);
    g_object_set (gl.video_queue, "leaky", 2, NULL);     // Set ouput display   
    g_object_set (gl.v_convert_queue, "leaky", 2, NULL);             

    /* Link all elements that can be automatically linked because they have "Always" pads */
    gst_bin_add_many (GST_BIN (this->pipeline), gl.source, gl.tsdemux,                                        // src
        gl.audio_queue, gl.aacparse, gl.avdec_aac, gl.audioconvert, gl.a_convert_queue, gl.audiosink,                               // audio
        gl.video_queue, gl.h264parser, gl.decoder, gl.decode_queue, gl.videoconvert, gl.v_convert_queue, gl.videosink,              // video
        NULL);

    /* Linking */
    if (// src
        gst_element_link_many (gl.source, gl.tsdemux, NULL) != TRUE ||
        // audio
        gst_element_link_many (gl.audio_queue, gl.aacparse, gl.avdec_aac, gl.audioconvert, gl.a_convert_queue, gl.audiosink, NULL) != TRUE ||
        // video
        gst_element_link_many (gl.video_queue, gl.h264parser, gl.decoder, gl.decode_queue, gl.videoconvert, gl.videosink, NULL) != TRUE 
        ) {
        g_printerr ("Elements could not be linked.\n");
        gst_object_unref (this->pipeline); 
    }

    /* add pad */
    g_signal_connect (gl.tsdemux, "pad-added", G_CALLBACK (on_pad_added), gl.audio_queue);
    g_signal_connect (gl.tsdemux, "pad-added", G_CALLBACK (on_pad_added), gl.video_queue);

    /* ------------------------------ Prep pipline -------------------------------- */

    /* -------------------------------_Link the ui -------------------------------- */
    gst_video_overlay_set_window_handle (GST_VIDEO_OVERLAY (gl.videosink), this->embed_xid);
    
    /* ------------------------------- Link the ui -------------------------------- */

    /* Start playing the pipeline */
    gst_element_set_state (this->pipeline, GST_STATE_PLAYING);

    /* Wait until error or EOS */
    bus = gst_element_get_bus (this->pipeline);

    gst_bus_add_watch (bus, my_bus_callback, this);
    gst_object_unref (bus);

    gtk_main ();

    /* ------------------------------- Post cleanup -------------------------------- */
    _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Pipeline stopped"); });

    gst_element_set_state(this->pipeline, GST_STATE_NULL);
    gst_object_unref (this->pipeline);

    this->running = false;
    this->killing = false;

    _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Resource cleanup complete"); });
    /* ------------------------------- Post cleanup -------------------------------- */
}

// ====================================
// _SrtVideoPlayer Class 
// ====================================

Napi::Value _SrtVideoPlayer::Start(const Napi::CallbackInfo &info){

    if (info.Length() < 1) {
        std::cout << "Callback function required";
        return Napi::String::New(info.Env(), "Callback function required");
    } else {
        // Thread safe emitter (https://github.com/nodejs/node-addon-api/blob/main/doc/threadsafe_function.md | https://chat.openai.com/share/229b5d00-3033-4f4f-9848-ed5e93c9498e)
        _emit = Napi::ThreadSafeFunction::New(
            info.Env(),
            info[0].As<Napi::Function>(),  // JavaScript function called asynchronously
            "emitter",              // Name
            0,                      // Unlimited queue
            1                       // Only one thread will use this initially
        );

        if (this->running) {
            std::cout << "Process still running, Please try again later.";
            _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Process still running, Please try again later."); });
            return Napi::String::New(info.Env(), "Process still running, Please try again later.");
        } else {
            this->running = true;

            std::thread t1([this] { this->th_Start(); });
            t1.detach();

            return Napi::String::New(info.Env(), "Pipline started");
        }
    }
}

Napi::Value _SrtVideoPlayer::Stop(const Napi::CallbackInfo &info){
    // Kill window
    if (this->killing) {
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Process is busy being stoped, Please try again later."); });
        return Napi::String::New(info.Env(), "Process is busy being stoped, Please try again later.");
    } else if (!this->running) {
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Process is not running, Please try again later."); });
        return Napi::String::New(info.Env(), "Process is not running, Please try again later.");
    } else {
        gtk_widget_hide(this->_window);
        this->killing = true;
        gtk_main_quit();
        return Napi::String::New(info.Env(), "Pipline stopped");
    }
}

// --------
// Setters
// --------
/**
 * [0] - _uri - Srt url - default: null
*/
Napi::Value _SrtVideoPlayer::SetUri(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { this->_uri = info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "_uri not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _pulseSink - Pulse audio sink - default: null
*/
Napi::Value _SrtVideoPlayer::SetSink(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { this->_pulseSink = info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "_pulseSink not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _paLatency - Palse audio latency (ms) - default: 50
*/
Napi::Value _SrtVideoPlayer::SetPALatency(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsNumber() ) { this->_paLatency = info[0].As<Napi::Number>(); } else { return Napi::String::New(info.Env(), "_paLatency not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _display - Output dispaly - default: 0
*/
Napi::Value _SrtVideoPlayer::SetDisplay(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { this->_display = ":" + info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "_display not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _fullScreen - full screen mode - default: false
*/
Napi::Value _SrtVideoPlayer::SetFullscreen(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsBoolean() ) { this->_fullScreen = info[0].As<Napi::Boolean>(); } else { return Napi::String::New(info.Env(), "_fullScreen not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * [0] - _name - Player Name - default: SrtVideoPlayer
*/
Napi::Value _SrtVideoPlayer::SetName(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { this->_name = info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "Player name not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}