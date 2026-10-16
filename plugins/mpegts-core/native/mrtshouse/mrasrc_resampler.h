/* The GstAudioResampler as mrasrc runs it (plan ch. 5 part 4.5), in one place so that
 * tests/asrc_bench.c measures exactly the element's settings. Plain C, header only. */
#pragma once
#include <gst/audio/audio.h>

/* Ratio resolution 1 / (hz * 1000): 0.02 ppm at 48 kHz (part 4.5). */
#define MRASRC_RATE_SCALE 1000

/* Kaiser at `quality`, the cutoff chosen from the nominal rates. The table is always the
 * interpolated one: a full table sized for scaled rates (48,000,000 phases) is gigabytes, and
 * the AUTO mode picks it whenever the rates reduce small (44.1 -> 48 kHz reduces to 147/160).
 * Created at the scaled nominal rates; mrasrc then moves in_rate with
 * gst_audio_resampler_update(), which keeps the filter phase. NULL on a bad format. */
static inline GstAudioResampler* mrasrc_resampler_new(GstAudioFormat format, gint channels,
                                                      guint quality, gint in_hz, gint out_hz) {
    GstStructure* opt = gst_structure_new_empty("mrasrc-resampler");
    gst_audio_resampler_options_set_quality(GST_AUDIO_RESAMPLER_METHOD_KAISER, quality, in_hz,
                                            out_hz, opt);
    gst_structure_set(opt, GST_AUDIO_RESAMPLER_OPT_FILTER_MODE,
                      GST_TYPE_AUDIO_RESAMPLER_FILTER_MODE,
                      GST_AUDIO_RESAMPLER_FILTER_MODE_INTERPOLATED,
                      GST_AUDIO_RESAMPLER_OPT_FILTER_INTERPOLATION,
                      GST_TYPE_AUDIO_RESAMPLER_FILTER_INTERPOLATION,
                      GST_AUDIO_RESAMPLER_FILTER_INTERPOLATION_CUBIC,
                      GST_AUDIO_RESAMPLER_OPT_MAX_PHASE_ERROR, G_TYPE_DOUBLE, 0.05, NULL);
    GstAudioResampler* r = gst_audio_resampler_new(
        GST_AUDIO_RESAMPLER_METHOD_KAISER, GST_AUDIO_RESAMPLER_FLAG_VARIABLE_RATE, format,
        channels, in_hz * MRASRC_RATE_SCALE, out_hz * MRASRC_RATE_SCALE, opt);
    gst_structure_free(opt);
    return r;
}
