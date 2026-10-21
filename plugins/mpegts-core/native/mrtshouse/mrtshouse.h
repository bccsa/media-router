/* What every element of libgstmrtshouse.so shares (plan ch. 3 WI-S0-7): the read-only `abi`
 * property, chapter 3 part 10's counters as read-only properties, the plugin's debug category
 * and the element types gstmrtshouse.cpp's factory table registers. */
#pragma once
#include <gst/gst.h>

#include <atomic>
#include <cstdint>

#include "mrtshouse_abi.h"

GST_DEBUG_CATEGORY_EXTERN(mrtshouse_debug);

/* Part 10's counters, element-wide running totals since the element started. An element fills
 * the ones its mrts objects keep and leaves the rest 0. */
struct MrtsHouseCounters {
    uint64_t desync_bytes = 0;              // PacketWalker::desync_bytes
    uint64_t cc_lost = 0;                   // CcTracker::lost
    uint64_t pes_oversize = 0;              // PesAssembler::oversize
    uint64_t pes_dropped_cc = 0;            // PesAssembler::dropped_cc
    uint64_t header_spans = 0;              // PesHeaderSpan::spans
    uint64_t psi_unsupported_sections = 0;  // PsiDiscovery::unsupported_sections
    uint64_t pes_no_pts = 0;                // PES headers without a PTS
    uint64_t dts_discarded = 0;             // Unwrapper::dts_discarded
};

/* Sits in each element's instance struct (construct it in instance_init with placement new).
 * The streaming thread publishes; get_property reads from any thread. */
class MrtsHouseCommon {
  public:
    /* The common properties take the ids from PROP_BASE up, clear of each element's own enum. */
    static constexpr guint PROP_BASE = 0x4000;
    static constexpr int N_COUNTERS = 8;
    static void install(GObjectClass* klass);   // from class_init
    bool get(guint prop_id, GValue* value) const;   // false: not a common property id
    void publish(const MrtsHouseCounters& c);
    void reset() { publish(MrtsHouseCounters()); }   // at start: the totals restart from 0

  private:
    std::atomic<uint64_t> counters_[N_COUNTERS]{};
};

/* The elements of the factory table, one source file each. */
GType gst_mrtsrestamp_get_type(void);
GType gst_mrasrc_get_type(void);
GType gst_mralignwatch_get_type(void);
GType gst_mrtsdemux_get_type(void);
