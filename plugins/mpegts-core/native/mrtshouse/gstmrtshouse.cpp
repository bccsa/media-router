/* libgstmrtshouse.so: the one GStreamer plugin of the house-clock elements (plan ch. 3 part 4.5
 * rules 3-4), loaded by path by both runners before any pipeline is parsed. A phase adds its
 * element as one row of kFactories; every element carries MrtsHouseCommon's properties. */
#include "mrtshouse.h"

/* GST_PLUGIN_DEFINE reads PACKAGE for GstPluginDesc.source. */
#define PACKAGE "media-router"

GST_DEBUG_CATEGORY(mrtshouse_debug);

namespace {

struct CounterSpec {
    const char* name;
    const char* nick;
    const char* blurb;
    uint64_t MrtsHouseCounters::*field;
};

#define TOTAL " Running total since the element started; 0 where this element keeps no such count."

/* Part 10's names; a counter's property id is PROP_BASE + 1 + its index here. */
const CounterSpec kCounters[] = {
    {"desync-bytes", "Desync bytes",
     "Bytes skipped to regain TS packet sync (mrts::PacketWalker)." TOTAL,
     &MrtsHouseCounters::desync_bytes},
    {"cc-lost", "CC lost",
     "Continuity-counter losses, as events, not packets (mrts::CcTracker)." TOTAL,
     &MrtsHouseCounters::cc_lost},
    {"pes-oversize", "PES oversize",
     "PES dropped for growing past the reassembly cap (mrts::PesAssembler, R9)." TOTAL,
     &MrtsHouseCounters::pes_oversize},
    {"pes-dropped-cc", "PES dropped on CC",
     "Open PES dropped by a continuity loss or reset (mrts::PesAssembler)." TOTAL,
     &MrtsHouseCounters::pes_dropped_cc},
    {"header-spans", "Header spans",
     "PES headers rewritten across two packets (mrts::PesHeaderSpan)." TOTAL,
     &MrtsHouseCounters::header_spans},
    {"psi-unsupported-sections", "PSI unsupported sections",
     "PAT/PMT sections with section_number != 0, which the parsers skip "
     "(mrts::PsiDiscovery)." TOTAL,
     &MrtsHouseCounters::psi_unsupported_sections},
    {"pes-no-pts", "PES without PTS", "PES headers that carried no PTS." TOTAL,
     &MrtsHouseCounters::pes_no_pts},
    {"dts-discarded", "DTS discarded",
     "DTS more than 5 s from their PTS, discarded as damage (mrts::Unwrapper)." TOTAL,
     &MrtsHouseCounters::dts_discarded},
};
#undef TOTAL
static_assert(sizeof(kCounters) / sizeof(kCounters[0]) == MrtsHouseCommon::N_COUNTERS,
              "one property per counter");

struct Factory {
    const char* name;
    GType (*type)(void);
};

/* mrtsrestamp took WI-S0-7's placeholder probe's place (WI-P1-4b); mrasrc is the capture
 * ASRC (WI-P1-8). */
const Factory kFactories[] = {
    {"mrtsrestamp", gst_mrtsrestamp_get_type},
    {"mrasrc", gst_mrasrc_get_type},
};

}  // namespace

void MrtsHouseCommon::install(GObjectClass* klass) {
    const GParamFlags ro = (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS);
    g_object_class_install_property(
        klass, PROP_BASE,
        g_param_spec_int("abi", "ABI",
                         "Element protocol version of this plugin (MRTSHOUSE_ABI); a runner "
                         "refuses a plugin below its own minimum.",
                         0, G_MAXINT, MRTSHOUSE_ABI, ro));
    for (int i = 0; i < N_COUNTERS; i++)
        g_object_class_install_property(
            klass, PROP_BASE + 1 + i,
            g_param_spec_uint64(kCounters[i].name, kCounters[i].nick, kCounters[i].blurb, 0,
                                G_MAXUINT64, 0, ro));
}

bool MrtsHouseCommon::get(guint prop_id, GValue* value) const {
    if (prop_id == PROP_BASE) {
        g_value_set_int(value, MRTSHOUSE_ABI);
        return true;
    }
    /* Unsigned: an id below the counters wraps far past the table. */
    const guint i = prop_id - (PROP_BASE + 1);
    if (i >= (guint)N_COUNTERS) return false;
    g_value_set_uint64(value, counters_[i].load(std::memory_order_relaxed));
    return true;
}

void MrtsHouseCommon::publish(const MrtsHouseCounters& c) {
    for (int i = 0; i < N_COUNTERS; i++)
        counters_[i].store(c.*kCounters[i].field, std::memory_order_relaxed);
}

static gboolean plugin_init(GstPlugin* plugin) {
    GST_DEBUG_CATEGORY_INIT(mrtshouse_debug, "mrtshouse", 0, "Media Router house-clock elements");
    /* Rank NONE: the runners place these by name; nothing may auto-plug them. */
    for (const Factory& f : kFactories)
        if (!gst_element_register(plugin, f.name, GST_RANK_NONE, f.type())) return FALSE;
    return TRUE;
}

GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, mrtshouse,
                  "Media Router house-clock MPEG-TS elements", plugin_init, MRTSHOUSE_VERSION,
                  "MIT/X11", "media-router", "https://github.com/bccsa/media-router")
