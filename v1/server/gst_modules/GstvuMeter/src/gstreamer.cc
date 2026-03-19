#include "GstvuMeter.h"
#include <cmath> 

// ====================================
// Main gstreamer class (Class links to all sub modules)
// ====================================
// Initialize native add-on
Napi::Object Init (Napi::Env env, Napi::Object exports) {
    _GstvuMeter::Init(env, exports);
    return exports;
}

// ====================================
// Constructor 
// ====================================
/**
 * [1] - _pipeline - Gstreamer _pipeline - default: null
*/
_GstvuMeter::_GstvuMeter(const Napi::CallbackInfo &info) : Napi::ObjectWrap<_GstvuMeter>(info) {
    int len = info.Length();

    if (len >= 1 && info[0].IsString() ) { this->_pipeline = info[0].As<Napi::String>().Utf8Value(); } else { std::cout << "_pipeline not supplied or invalid type\n"; };
}

Napi::FunctionReference _GstvuMeter::constructor;

// ====================================
// Gstreamer message bus
// ====================================

/**
 * Callback messages from bus
*/
static gboolean my_bus_callback (GstBus * bus, GstMessage * message, gpointer data)
{
    // test class and class type before entering to avoid function crashing due to invalid class
    _GstvuMeter *obj = (_GstvuMeter *) data;
    if (data != nullptr && obj) {
        try {
            switch (GST_MESSAGE_TYPE (message)) {
                // get vu data
                case GST_MESSAGE_ELEMENT:{
                    const GstStructure *s = gst_message_get_structure (message);
                    const gchar *name = gst_structure_get_name (s);

                    if (strcmp (name, "level") == 0) {
                        _emit.NonBlockingCall(gst_structure_copy(s), [](Napi::Env env, Napi::Function _emit, GstStructure *s) { // https://github.com/nodejs/node-addon-api/issues/1457
                            const GValue *array_val;
                            GValueArray *rms_arr, *peak_arr, *decay_arr;

                            /* the values are packed into GValueArrays with the value per channel */
                            array_val = gst_structure_get_value (s, "rms");
                            rms_arr = (GValueArray *) g_value_get_boxed (array_val);

                            array_val = gst_structure_get_value (s, "peak");
                            peak_arr = (GValueArray *) g_value_get_boxed (array_val);

                            array_val = gst_structure_get_value (s, "decay");
                            decay_arr = (GValueArray *) g_value_get_boxed (array_val);

                            gdouble rms_dB, peak_dB, decay_dB;
                            const GValue *value;
                            gint i;

                            Napi::Object obj_rms = Napi::Object::New(env);
                            Napi::Object obj_peak = Napi::Object::New(env);
                            Napi::Object obj_decay = Napi::Object::New(env);

                            gint channels = rms_arr->n_values;
                            for (i = 0; i < channels; ++i) {
                                value = g_value_array_get_nth (rms_arr, i);
                                rms_dB = g_value_get_double (value);
                                obj_rms.Set(uint32_t(i), rms_dB);

                                value = g_value_array_get_nth (peak_arr, i);
                                peak_dB = g_value_get_double (value);
                                obj_peak.Set(uint32_t(i), peak_dB);

                                value = g_value_array_get_nth (decay_arr, i);
                                decay_dB = g_value_get_double (value);
                                obj_decay.Set(uint32_t(i), decay_dB);
                            }

                            Napi::Object res = Napi::Object::New(env);
                            res.Set("rms_dB", obj_rms);
                            res.Set("peak_dB", obj_peak);
                            res.Set("decay_dB", obj_decay);

                            Emit(env, _emit, res); 
                            // free struct
                            gst_structure_free(s);
                        });
                    }

                    break;
                }
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
                        g_print ("Reseting pipline, (reload_cound > reload_limit)");
                        sleep(2);
                        abort();
                    } else {
                        // Reload pipeline on stream error (This is that the srt keep's trying to reconnect, when an stream error occurs)
                        g_print ("Reloading pipline");
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
                        g_print ("Reseting pipline, (reload_cound > reload_limit)");
                        sleep(2);
                        abort();
                    } else {
                        // Reload pipeline on stream error (This is that the srt keep's trying to reconnect, when an stream error occurs)
                        g_print ("Reloading pipline");
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
void _GstvuMeter::th_Start(std::string _pipeline_) {
    // _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Pipeline started"); });
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
    // _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Pipeline stopped"); });

    gst_element_set_state(this->pipeline, GST_STATE_NULL);
    gst_object_unref (this->pipeline);
    g_source_remove (bus_watch_id);
    g_main_loop_unref (this->loop);

    this->running = false;
    this->killing = false;

    // _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Resource cleanup complete"); });
    /* ------------------------------- Post cleanup -------------------------------- */
}

// ====================================
// _GstvuMeter Class 
// ====================================

Napi::Value _GstvuMeter::Start(const Napi::CallbackInfo &info){

    if (info.Length() < 1) {
        std::cout << "Callback function required";
        return Napi::String::New(info.Env(), "Callback function required");
    } else {
        // Thread safe emitter (https://github.com/nodejs/node-addon-api/blob/main/doc/threadsafe_function.md | https://chat.openai.com/share/229b5d00-3033-4f4f-9848-ed5e93c9498e)
        _emit = Napi::ThreadSafeFunction::New(
            info.Env(), info[0].As<Napi::Function>(), "emitter", 0, 1
        );

        if (this->running) {
            std::cout << "Process still running, Please try again later.";
            // _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Process still running, Please try again later."); });
            return Napi::String::New(info.Env(), "Process still running, Please try again later.");
        } else {
            this->running = true;

            std::thread t1([this] { this->th_Start(this->_pipeline); });
            t1.detach();

            return Napi::String::New(info.Env(), "Pipline started");
        }
    }
}

Napi::Value _GstvuMeter::Stop(const Napi::CallbackInfo &info){
    // Kill window
    if (this->killing) {
        // _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Process is busy being stoped, Please try again later."); });
        return Napi::String::New(info.Env(), "Process is busy being stoped, Please try again later.");
    } else if (!this->running) {
        // _emit.NonBlockingCall([](Napi::Env env, Napi::Function _emit) { Emit(env, _emit, "Process is not running, Please try again later."); });
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
Napi::Value _GstvuMeter::SetPipeline(const Napi::CallbackInfo &info){
    int len = info.Length();
    if (len >= 1 && info[0].IsString() ) { this->_pipeline = info[0].As<Napi::String>().Utf8Value(); } else { return Napi::String::New(info.Env(), "_pipeline not supplied or invalid type\n"); };
    return Napi::Number::New(info.Env(), 0);
}

// Register and initialize native add-on
NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
