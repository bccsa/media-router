#include "GstGeneric.h"
#include <gst/gst.h>
#include <glib.h>

// ====================================
// Main gstreamer class (Class links to all sub modules)
// ====================================
// Initialize native add-on
Napi::Object Init (Napi::Env env, Napi::Object exports) {
    _GstGeneric::Init(env, exports);
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
                    GError *err;
                    gchar *debug;
                    gst_message_parse_error (message, &err, &debug);
                    g_print ("Error: %s\n", err->message);

                    g_error_free (err);
                    g_free (debug);

                    obj->reload_count++;
                    if (obj->reload_count > obj->reload_limit) {
                        // Hard reload pipeline if reload_count passed the reload limit
                        // * A hard reload, abourds the pipeline and nodejs will restart it, more cpu intensave
                        // * This is to avoid a memory build up each time the pipeline soft reload's, 
                        // * As of now we cant find the memory leak, so this is done as a workaround to avoid the devices freezing up due to running out of memory
                        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Reseting pipline, (reload_cound > reload_limit)"); });
                        sleep(2);
                        abort();
                    } else {
                        // Reload pipeline on stream error (This is that the srt keep's trying to reconnect, when an stream error occurs)
                        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Reloading pipline"); });
                        g_main_loop_quit (obj->loop);
                        gst_element_set_state(obj->pipeline, GST_STATE_NULL);
                        sleep(1);
                        obj->th_Start(obj->_pipeline); 
                    }

                    break;
                }
                case GST_MESSAGE_EOS:{
                    /* end-of-stream */
                    obj->reload_count++;
                    if (obj->reload_count > obj->reload_limit) {
                        // Hard reload pipeline if reload_count passed the reload limit
                        // * A hard reload, abourds the pipeline and nodejs will restart it, more cpu intensave
                        // * This is to avoid a memory build up each time the pipeline soft reload's, 
                        // * As of now we cant find the memory leak, so this is done as a workaround to avoid the devices freezing up due to running out of memory
                        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Reseting pipline, (reload_cound > reload_limit)"); });
                        sleep(2);
                        abort();
                    } else {
                        // Reload pipeline on stream error (This is that the srt keep's trying to reconnect, when an stream error occurs)
                        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Reloading pipline"); });
                        g_main_loop_quit (obj->loop);
                        gst_element_set_state(obj->pipeline, GST_STATE_NULL);
                        sleep(1);
                        obj->th_Start(obj->_pipeline); 
                    }

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
void _GstGeneric::th_Start(std::string _pipeline_) {
    _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Pipeline started"); });
    /* Varaibles */
    GstBus *bus;
    guint bus_watch_id;
    /* Initialize GStreamer */
    gst_init (NULL, NULL);

    /* ------------------------------ Prep pipline -------------------------------- */

    /* Create the pipeline */
    this->pipeline = gst_parse_launch(_pipeline_.c_str() ,NULL);

    /* ------------------------------ Prep pipline -------------------------------- */

    
    /* ------------------------------- Link the ui -------------------------------- */

    /* Start playing the pipeline */
    gst_element_set_state (this->pipeline, GST_STATE_PLAYING);

    /* Wait until error or EOS */
    bus = gst_element_get_bus (this->pipeline);

    bus_watch_id = gst_bus_add_watch (bus, my_bus_callback, this);
    gst_object_unref (bus);

    this->loop = g_main_loop_new (NULL, FALSE);
    g_main_loop_run (this->loop);

    /* ------------------------------- Post cleanup -------------------------------- */
    _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Pipeline stopped"); });

    gst_element_set_state(this->pipeline, GST_STATE_NULL);
    gst_object_unref (this->pipeline);
    g_source_remove (bus_watch_id);
    g_main_loop_unref (this->loop);

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

            std::thread t1([this] { this->th_Start(this->_pipeline); });
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
        g_main_loop_quit (this->loop);
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
    std::string valType = info[1].As<Napi::String>().Utf8Value();
    std::string key = info[2].As<Napi::String>().Utf8Value();
    if (valType == "gdouble") {
        gdouble value = info[3].As<Napi::Number>();
        g_object_set (_element, key.c_str(), value, NULL);
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Set | gDouble Value Updated"); });
    } else if (valType == "int") {
        gint64 value = info[3].As<Napi::Number>();
        g_object_set (_element, key.c_str(), value, NULL);
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Set | Int Value Updated"); });
    } else if (valType == "string") {
        std::string value = info[3].As<Napi::String>().Utf8Value();
        g_object_set (_element, key.c_str(), value.c_str(), NULL);
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Set | String Value Updated"); });
    } else if (valType == "bool") {
        bool value = info[3].As<Napi::Boolean>();
        g_object_set (_element, key.c_str(), value, NULL);
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Set | Boolean Value Updated"); });
    } else {
        _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Set | Invalid Value type"); });
    }
    
    return Napi::String::New(info.Env(), "Set | Changed " + _elementName + ": " + key);
}

// --------
// Getters
// --------

/**
 * Convert GstStructure to Json Object
*/
static Napi::Object struct_to_json(const Napi::CallbackInfo &info, GstStructure *d) {
    Napi::Object res = Napi::Object::New(info.Env());

    // Null check to prevent segmentation fault
    if (!d) {
        std::cerr << "struct_to_json | Null GstStructure encountered" << std::endl;
        return res;
    }

    try {
        for (gint i = 0; i < gst_structure_n_fields(d); ++i) {
            const gchar *name = gst_structure_nth_field_name(d, i);
            if (!name) {
                std::cerr << "struct_to_json | Null field name encountered" << std::endl;
                continue;
            }

            const GValue *value = gst_structure_get_value(d, name);
            if (!value) {
                std::cerr << "struct_to_json | Null value encountered for field: " << name << std::endl;
                continue;
            }

            // Process arrays
            if (G_VALUE_TYPE(value) == G_TYPE_VALUE_ARRAY) {
                GValueArray *_arr = (GValueArray *)g_value_get_boxed(value);
                if (!_arr) {
                    std::cerr << "struct_to_json | Null GValueArray encountered for field: " << name << std::endl;
                    continue;
                }

                Napi::Array arr = Napi::Array::New(info.Env(), _arr->n_values);
                for (gint k = 0; k < _arr->n_values; ++k) {
                    const GValue *_value = g_value_array_get_nth(_arr, k);
                    if (!_value) {
                        std::cerr << "struct_to_json | Null GValue in array at index " << k << std::endl;
                        continue;
                    }

                    if (G_VALUE_TYPE(_value) == GST_TYPE_STRUCTURE) {
                        GstStructure *_d = (GstStructure *)g_value_get_boxed(_value);
                        if (_d) {
                            arr.Set(uint32_t(k), struct_to_json(info, _d));
                        }
                    } else {
                        gchar *strVal = g_strdup_value_contents(_value);
                        if (strVal) {
                            arr.Set(uint32_t(k), strVal);
                            g_free(strVal);
                        }
                    }
                }
                res.Set(name, arr);

            // Process structures
            } else if (G_VALUE_TYPE(value) == GST_TYPE_STRUCTURE) {
                GstStructure *_d = (GstStructure *)g_value_get_boxed(value);
                if (_d) {
                    res.Set(name, struct_to_json(info, _d));
                } else {
                    std::cerr << "struct_to_json | Null GstStructure encountered for field: " << name << std::endl;
                }

            // Process value pairs
            } else {
                gchar *strVal = g_strdup_value_contents(value);
                if (strVal) {
                    res.Set(name, strVal);
                    g_free(strVal);
                } else {
                    std::cerr << "struct_to_json | Failed to convert value for field: " << name << std::endl;
                }
            }
        }
    } catch (const std::exception &e) {
        std::cerr << "Exception caught in struct_to_json: " << e.what() << std::endl;
    }

    return res;
}

/**
* Get SRT Bitrate ( https://github.com/gstreamer-java/gst1-java-core/issues/173 )
*/
Napi::Value _GstGeneric::GetSrtStats(const Napi::CallbackInfo &info) {
    try {
        if (info.Length() < 1) {
            _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { 
                Emit(env, _emit, "GetSrtStats | Element name not supplied."); 
            });
            return Napi::Number::New(info.Env(), 0);
        }

        if (!this->pipeline) {
            _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { 
                Emit(env, _emit, "GetSrtStats | Pipeline is not created yet, please try again later"); 
            });
            return Napi::Number::New(info.Env(), 0);
        }

        std::string _elementName = info[0].As<Napi::String>().Utf8Value();
        GstElement *_element = gst_bin_get_by_name(GST_BIN(this->pipeline), _elementName.c_str());

        if (!_element) {
            _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { 
                Emit(env, _emit, "GetSrtStats | Element does not exist, please make sure the name is correct"); 
            });
            return Napi::Number::New(info.Env(), 0);
        }

        // Get SRT stats
        GValue propValue = G_VALUE_INIT;
        g_value_init(&propValue, gst_structure_get_type());
        g_object_get_property(G_OBJECT(_element), "stats", &propValue);

        GstStructure *d = (GstStructure *)g_value_get_boxed(&propValue);
        if (!d || !GST_IS_STRUCTURE(d)) {
            std::cerr << "GetSrtStats | Failed to get valid SRT stats from element: " << _elementName << std::endl;
            g_value_unset(&propValue);
            return Napi::Number::New(info.Env(), 0);
        }

        Napi::Object res = struct_to_json(info, d);
        g_value_unset(&propValue);

        return res;

    } catch (const std::exception &e) {
        std::cerr << "Exception caught in GetSrtStats: " << e.what() << std::endl;
    }

    return Napi::Number::New(info.Env(), 0);
}

// Register and initialize native add-on
NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
