/* asrc_bench (plan ch. 5 WI-P1-8): the CPU of mrasrc's GstAudioResampler, built by
 * mrasrc_resampler.h exactly as the element builds it, per stream against the Pi 4 budget:
 * <= 3 % of one core per stereo 48 kHz stream, <= 10 % per 8 channels. Run by hand on the device:
 *
 *   asrc_bench [--seconds N] [--buffer FRAMES] [--rate IN_HZ] [--out-rate HZ] [--quality Q]
 *
 * Per format (S16LE, S32LE, F32LE), channel count (2, 8) and quality (4, then 2; or only Q), a
 * 1 kHz tone runs through the resampler with the ratio moving as the servo moves it: a +50 ppm
 * device and a new in_rate every buffer (the phase loop's ~1 ppm steps), so every buffer pays a
 * gst_audio_resampler_update. Cost = thread CPU time / audio time.
 * Exit 0: quality 4 within budget; 1: within it only at quality 2 (set quality=2); 2: over at
 * quality 2 too (WI-P1-8's speexdsp backend); 3: usage or setup error. */
/* clock_gettime and CLOCK_THREAD_CPUTIME_ID under -std=c11. */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "mrtshouse/mrasrc_resampler.h"

typedef struct {
    const char* name;
    GstAudioFormat format;
    int bps;
} Format;

static const Format kFormats[] = {
    {"S16LE", GST_AUDIO_FORMAT_S16, 2},
    {"S32LE", GST_AUDIO_FORMAT_S32, 4},
    {"F32LE", GST_AUDIO_FORMAT_F32, 4},
};
static const int kChannels[] = {2, 8};

static double thread_cpu_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

/* A 1 kHz tone at -1 dBFS in every channel, interleaved: the content never changes the cost. */
static void fill_tone(void* buf, const Format* f, int channels, int frames, int rate) {
    const double amp = 0.891;
    for (int i = 0; i < frames; i++) {
        const double v = amp * sin(2.0 * G_PI * 1000.0 * (double)i / (double)rate);
        for (int c = 0; c < channels; c++) {
            const int k = i * channels + c;
            if (f->format == GST_AUDIO_FORMAT_S16)
                ((gint16*)buf)[k] = (gint16)lrint(v * 32767.0);
            else if (f->format == GST_AUDIO_FORMAT_S32)
                ((gint32*)buf)[k] = (gint32)lrint(v * 2147483647.0);
            else
                ((gfloat*)buf)[k] = (gfloat)v;
        }
    }
}

/* The servo's command for buffer k: round(in_hz * 1000 / (1 + eps)), eps a +50 ppm device plus a
 * +-1 ppm step every buffer, never 1:1 (as AsrcServo::in_rate). */
static gint in_rate_for(int in_hz, int out_hz, long k) {
    const double eps = 50e-6 + ((k % 3) - 1) * 1e-6;
    gint r = (gint)llround((double)in_hz * MRASRC_RATE_SCALE / (1.0 + eps));
    if (r == out_hz * MRASRC_RATE_SCALE) r -= 1;
    return r;
}

/* Percent of one core for `seconds` of audio, or a negative value on a setup error. */
static double run(const Format* f, int channels, guint quality, int in_hz, int out_hz,
                  int buffer, int seconds, double* updates_per_s) {
    GstAudioResampler* r = mrasrc_resampler_new(f->format, channels, quality, in_hz, out_hz);
    if (!r) return -1.0;
    // Room for the servo's 1000 ppm clamp and the filter's slack.
    const int out_cap = (int)((gint64)buffer * out_hz / in_hz) + 64;
    void* in = g_malloc((gsize)buffer * channels * f->bps);
    void* out = g_malloc((gsize)out_cap * channels * f->bps);
    fill_tone(in, f, channels, buffer, in_hz);
    const long warm = (long)in_hz / buffer;   // one second untimed: tables, caches
    const long total = warm + (long)seconds * in_hz / buffer;
    gint cur = in_hz * MRASRC_RATE_SCALE;
    long updates = 0;
    double t0 = 0.0;
    for (long k = 0; k < total; k++) {
        if (k == warm) {
            t0 = thread_cpu_s();
            updates = 0;
        }
        const gint want = in_rate_for(in_hz, out_hz, k);
        if (want != cur) {
            gst_audio_resampler_update(r, want, out_hz * MRASRC_RATE_SCALE, NULL);
            cur = want;
            updates++;
        }
        const gsize n = gst_audio_resampler_get_out_frames(r, (gsize)buffer);
        if (n > (gsize)out_cap) {   // never inside the servo's clamp
            g_free(in);
            g_free(out);
            gst_audio_resampler_free(r);
            return -1.0;
        }
        gpointer ip = in, op = out;
        gst_audio_resampler_resample(r, &ip, (gsize)buffer, &op, n);
    }
    const double cpu = thread_cpu_s() - t0;
    const double audio = (double)(total - warm) * buffer / in_hz;
    *updates_per_s = (double)updates / audio;
    g_free(in);
    g_free(out);
    gst_audio_resampler_free(r);
    return 100.0 * cpu / audio;
}

typedef struct {
    const char* flag;
    int* value;
    int lo, hi;
} Option;

int main(int argc, char** argv) {
    gst_init(&argc, &argv);
    int seconds = 20, buffer = 1024, in_hz = 48000, out_hz = 48000, only_q = -1;
    const Option opts[] = {
        {"--seconds", &seconds, 1, 3600},     {"--buffer", &buffer, 1, 65536},
        {"--rate", &in_hz, 1000, 768000},     {"--out-rate", &out_hz, 1000, 768000},
        {"--quality", &only_q, 0, 10},
    };
    for (int i = 1; i < argc; i++) {
        const Option* o = NULL;
        for (size_t k = 0; k < G_N_ELEMENTS(opts); k++)
            if (!strcmp(argv[i], opts[k].flag)) o = &opts[k];
        char* end = NULL;
        errno = 0;
        const long v = o && i + 1 < argc ? strtol(argv[++i], &end, 10) : -1;
        if (!o || errno || !end || *end || v < o->lo || v > o->hi) {
            fprintf(stderr, "usage: asrc_bench [--seconds 1-3600] [--buffer FRAMES] "
                            "[--rate IN_HZ] [--out-rate HZ] [--quality 0-10]\n");
            return 3;
        }
        *o->value = (int)v;
    }
    const guint qualities[2] = {4, 2};
    const int nq = only_q >= 0 ? 1 : 2;
    printf("mrasrc resampler bench: %d -> %d Hz, %d-frame buffers, %d s per row "
           "(budget: 3 %% of one core per stereo stream, 10 %% per 8 channels)\n",
           in_hz, out_hz, buffer, seconds);
    gboolean within[2] = {TRUE, TRUE};
    for (int qi = 0; qi < nq; qi++) {
        const guint q = only_q >= 0 ? (guint)only_q : qualities[qi];
        for (size_t fi = 0; fi < G_N_ELEMENTS(kFormats); fi++) {
            for (size_t ci = 0; ci < G_N_ELEMENTS(kChannels); ci++) {
                const int ch = kChannels[ci];
                const double budget = ch == 2 ? 3.0 : 10.0;
                double ups = 0.0;
                const double pct =
                    run(&kFormats[fi], ch, q, in_hz, out_hz, buffer, seconds, &ups);
                if (pct < 0) {
                    fprintf(stderr, "cannot make the resampler: %s %d ch\n", kFormats[fi].name,
                            ch);
                    return 3;
                }
                const gboolean ok = pct <= budget;
                within[qi] = within[qi] && ok;
                printf("  quality %2u  %s  %d ch  %6.2f %% of one core  (budget %4.1f %%, "
                       "%5.1f updates/s)  %s\n",
                       q, kFormats[fi].name, ch, pct, budget, ups, ok ? "ok" : "OVER");
            }
        }
    }
    if (only_q >= 0) {
        printf("verdict: quality %d %s\n", only_q, within[0] ? "within budget" : "over budget");
        return within[0] ? 0 : 2;
    }
    if (within[0]) {
        printf("verdict: quality 4 within budget\n");
        return 0;
    }
    if (within[1]) {
        printf("verdict: quality 4 over budget, quality 2 within it: set mrasrc quality=2 and "
               "re-measure (WI-P1-8)\n");
        return 1;
    }
    printf("verdict: over budget at quality 2 too: the speexdsp backend (WI-P1-8)\n");
    return 2;
}
