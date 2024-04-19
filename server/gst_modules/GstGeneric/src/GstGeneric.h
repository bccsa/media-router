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

// ====================================
// Constructor 
// ====================================
/**
 * [1] - _pipeline - Gstreamer _pipeline - default: null
*/
_GstGeneric::_GstGeneric(const Napi::CallbackInfo &info) : Napi::ObjectWrap<_GstGeneric>(info) {
    int len = info.Length();

    if (len >= 1 && info[0].IsString() ) { this->_pipeline = info[0].As<Napi::String>().Utf8Value(); } else { std::cout << "_pipeline not supplied or invalid type\n"; };
}

Napi::FunctionReference _GstGeneric::constructor;

// ====================================
// Gstreamer message bus
// ====================================

/**
 * Callback messages from bus
*/
static gboolean my_bus_callback (GstBus * bus, GstMessage * message, gpointer data)
{
    // test class and class type before entering to avoid function crashing due to invalid class
    _GstGeneric *obj = (_GstGeneric *) data;
    if (data != nullptr && obj) {
        try {
            switch (GST_MESSAGE_TYPE (message)) {
                case GST_MESSAGE_ERROR:{
                    std::string errorMessage;
                    GError *err;
                    gchar *debug;
                    gst_message_parse_error (message, &err, &debug);
                    g_print ("Error: %s\n", err->message);
                    
                    // _emit.NonBlockingCall([err](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, g_strdup(err->message)); });
                    _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Reloading pipline"); });

                    // Reload pipeline on stream error (This is that the srt keep's trying to reconnect, when an stream error occurs)
                    gst_element_set_state(obj->pipeline, GST_STATE_NULL);
                    sleep(5);
                    gst_element_set_state (obj->pipeline, GST_STATE_PLAYING);

                    g_error_free (err);
                    g_free (debug);

                    break;
                }
                case GST_MESSAGE_EOS:{
                    /* end-of-stream */
                    _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "EOS | Reloading pipline"); });
                    
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

// ====================================
// Start Gstreamer
// ====================================

/**
 * Start Gstreamer in a seperate thread
*/
void _GstGeneric::th_Start() {
    _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Pipeline started"); });
    /* Varaibles */
    // std::string uri = this->_uri;
    // Gstreamer
    GstBus *bus;
    /* Initialize GStreamer */
    gst_init (NULL, NULL);

    /* ------------------------------ Prep pipline -------------------------------- */

    /* Create the pipeline */
    this->pipeline = gst_parse_launch(this->_pipeline.c_str() ,NULL);

    /* ------------------------------ Prep pipline -------------------------------- */

    
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
// _GstGeneric Class 
// ====================================

Napi::Value _GstGeneric::Start(const Napi::CallbackInfo &info){

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

Napi::Value _GstGeneric::Stop(const Napi::CallbackInfo &info){
    // Kill window
    if (this->killing) {
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Process is busy being stoped, Please try again later."); });
        return Napi::String::New(info.Env(), "Process is busy being stoped, Please try again later.");
    } else if (!this->running) {
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Process is not running, Please try again later."); });
        return Napi::String::New(info.Env(), "Process is not running, Please try again later.");
    } else {
        this->killing = true;
        gtk_main_quit();
        return Napi::String::New(info.Env(), "Pipline stopped");
    }
}

// --------
// Setters
// --------
/**
 * [0] - _pipeline - Srt Pipeline - default: null
*/
Napi::Value _GstGeneric::SetPipeline(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { this->_pipeline = info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "_pipeline not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}
/**
 * General setter
 * [0] - elementName - Name of element in pipeline - default: null
 * [1] - key - Key to set - default: null
 * [2] - value - value to set - default: null
*/
Napi::Value _GstGeneric::Set(const Napi::CallbackInfo &info){
    // valadity checks
    int len = info.Length();
    if ( len >= 3 ) {  } else { return Napi::String::New(info.Env(), "Set | Not all needed items is supplied\n * General setter\n * [0] - elementName - Name of element in pipeline - default: null\n * [1] - key - Key to set - default: null\n * [2] - value - value to set - default: null"); };
    
    if (!this->pipeline) { 
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Set | Pipeline is not created yet, please try again later"); });
        return Napi::Number::New(info.Env(), 0);
    };

    std::string _elementName = info[0].As<Napi::String>().Utf8Value();
    GstElement *_element = gst_bin_get_by_name(GST_BIN(this->pipeline), _elementName.c_str()); // https://gist.github.com/justinjoy/243e5874922cd553b6a25a29247c5900

    if (!_element) {
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Set | Element does not exsist, please make sure the name is correct"); });
        return Napi::Number::New(info.Env(), 0);
    }

    // update field
    std::string key = info[1].As<Napi::String>().Utf8Value();
    int value = info[2].As<Napi::Number>();
    g_object_set (_element, key.c_str(), value, NULL); 
    
    return Napi::String::New(info.Env(), "Set | Changed " + _elementName + ": " + key);
}

// --------
// Getters
// --------

/**
 * Convert GstStructure to Json Object
*/
static Napi::Object struct_to_json (const Napi::CallbackInfo &info, GstStructure * d) {
    const gchar *name;
    const GValue *value;
    Napi::Object res = Napi::Object::New(info.Env());
    
    for (gint i = 0; i < gst_structure_n_fields(d); ++i) {
        name = gst_structure_nth_field_name(d, i);
        value = gst_structure_get_value(d, name);

        // Proccess array'
        if (G_VALUE_TYPE(value) == G_TYPE_VALUE_ARRAY) {
            GValueArray *_arr = (GValueArray *) g_value_get_boxed (value);
            for (gint k = 0; k < _arr->n_values; ++k) {
                const GValue *_value = g_value_array_get_nth(_arr, k);
                if (G_VALUE_TYPE(_value) == GST_TYPE_STRUCTURE) {
                    GstStructure *_d = (GstStructure*)g_value_get_boxed(_value);
                    Napi::Object _res = struct_to_json(info, _d);
                    res.Set(uint32_t(k), _res);
                } else {
                    gchar * strVal = g_strdup_value_contents (_value);
                    res.Set(uint32_t(k), strVal);
                    free (strVal);
                }
            }
        // Process Structures
        } else if (G_VALUE_TYPE(value) == GST_TYPE_STRUCTURE) { 
            GstStructure *_d = (GstStructure*)g_value_get_boxed(value);
            Napi::Object _res = struct_to_json(info, _d);
            res.Set(uint32_t(i), _res);
        // Process Value pairs
        } else {
            gchar * strVal = g_strdup_value_contents (value);
            res.Set(name, strVal);
            free (strVal);
        }
    }    

    return res;
}

/**
* Get SRT Bitrate ( https://github.com/gstreamer-java/gst1-java-core/issues/173 )
*/
Napi::Value _GstGeneric::GetSrtStats(const Napi::CallbackInfo &info){
    // valadity checks
    int len = info.Length();
    if (len < 1) { 
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "GetSrtStats | Element name not supplied."); });
        return Napi::Number::New(info.Env(), 0);
    };

    if (!this->pipeline) { 
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "GetSrtStats | Pipeline is not created yet, please try again later"); });
        return Napi::Number::New(info.Env(), 0);
    };

    std::string _elementName = info[0].As<Napi::String>().Utf8Value();
    GstElement *_element = gst_bin_get_by_name(GST_BIN(this->pipeline), _elementName.c_str()); // https://gist.github.com/justinjoy/243e5874922cd553b6a25a29247c5900

    if (!_element) {
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "GetSrtStats | Element does not exsist, please make sure the name is correct"); });
        return Napi::Number::New(info.Env(), 0);
    }

    // get srt stats
    GValue propValue = G_VALUE_INIT;
    GType gstStructure = gst_structure_get_type();
    g_value_init(&propValue, gstStructure);
    g_object_get_property(G_OBJECT(_element), "stats", &propValue);
    GstStructure *d = (GstStructure*)g_value_get_boxed(&propValue);
    Napi::Object res = struct_to_json(info, d);
    g_value_unset(&propValue);

    return res;
}