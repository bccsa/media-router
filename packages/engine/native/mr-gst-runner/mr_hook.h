/* mr_hook.h — the native form of a runner hook (ADR-0020).
 *
 * A plugin that needs pad-added logic, per-buffer work or timers INSIDE the
 * pipeline runner ships it as a runner hook (`PipelineDescription.runnerHooks`,
 * plugins/README.md). The python runner imports `<module>.py` from the
 * plugin's `py/` dir; the native runner (mr-gst-runner) dlopens
 * `libmrhook_<module>.so` from the plugin's `native/<tool>/` dir (or its
 * libexec install), checks `mr_hook_abi` and calls `mr_hook_install` /
 * `mr_hook_clear`. Same seam, same
 * config JSON, same events; the python module stays the reference.
 *
 * The .so is built by the plugin's own Makefile (plain make, discovered by
 * the root Makefile like every native tool) and links against GStreamer and
 * whatever it needs; the runner passes it nothing but the pipeline, the
 * config as JSON text and three callbacks. One hook module per process: a
 * pipeline names each module at most once.
 */
#ifndef MR_HOOK_H
#define MR_HOOK_H

#include <gst/gst.h>

#ifdef __cplusplus
extern "C" {
#endif

/** ABI version: the runner refuses a hook reporting another. */
#define MR_HOOK_ABI 1

typedef struct MrHookCtx {
    /** Opaque, handed back to every callback. */
    void* user;
    /** Emit one engine event: `json` is a complete JSON object with an
     *  `event` member (`warning`, `error`, `pad_linked`, …). */
    void (*emit_event)(void* user, const char* json);
    /** Emit on the module's plugin-event channel: `payload_json` is a JSON value. */
    void (*emit_plugin_event)(void* user, const char* channel, const char* payload_json);
    /** One stderr log line (the runner prefixes it). */
    void (*log)(void* user, const char* line);
} MrHookCtx;

/** Exported by every hook: the ABI it was built against. */
int mr_hook_abi(void);

/** Install on `pipeline` before PLAYING. `config_json` is the entry's
 *  `config` (a JSON value, "null" when absent). Returns 0 on success; a
 *  non-zero return is reported as a warning and the hook is skipped — it
 *  must never take the media pipeline down. */
int mr_hook_install(GstElement* pipeline, const char* config_json, const MrHookCtx* ctx);

/** Tear down everything the install put in place (pipeline stop). */
void mr_hook_clear(void);

#ifdef __cplusplus
}
#endif

#endif /* MR_HOOK_H */
