// stamper::handle_message: an episode off the house clock (B-203, `mrtsstamp-off-clock`) goes to the
// module as the plugin event `stamp_off_clock`, naming the egress; the segment warning stays as it
// was. Events are read back off ipc's data-pipe fd 4, a file here.
#include <fcntl.h>
#include <gst/gst.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <string>
#include <vector>

#include "../ipc.h"
#include "../json_util.h"
#include "../stamper.h"
#include "mrts/tests/check.h"

namespace {

int g_events_fd = -1;

/** Every event line written since the last call, parsed; non-JSON lines skipped. */
std::vector<JsonObject*> take_events() {
    std::string all;
    char buf[4096];
    ssize_t n;
    while ((n = ::read(g_events_fd, buf, sizeof buf)) > 0) all.append(buf, (size_t)n);
    std::vector<JsonObject*> out;
    size_t at = 0, nl;
    while ((nl = all.find('\n', at)) != std::string::npos) {
        const std::string line = all.substr(at, nl - at);
        at = nl + 1;
        if (line.rfind("GST_JSON:", 0) != 0) continue;
        if (JsonObject* o = mr::json_parse_object(line.substr(9), nullptr)) out.push_back(o);
    }
    return out;
}

void unref(std::vector<JsonObject*>& v) {
    for (JsonObject* o : v) json_object_unref(o);
    v.clear();
}

GstStructure* off_clock(int pid, gint64 offset_ns, guint64 count) {
    return gst_structure_new("mrtsstamp-off-clock", "pid", G_TYPE_INT, pid, "offset", G_TYPE_INT64, offset_ns,
                             "count", G_TYPE_UINT64, count, nullptr);
}

}  // namespace

int main(int argc, char** argv) {
    gchar* tmp = g_dir_make_tmp("mr-stamper-msg-XXXXXX", nullptr);
    if (!tmp) {
        std::printf("FAIL no temp dir\n");
        return 1;
    }
    const std::string events = std::string(tmp) + "/events";
    // ipc's data-pipe mode: commands on fd 3 (never read here), events on fd 4, a file.
    int in = ::open("/dev/null", O_RDONLY), out = ::open(events.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0600);
    int in_hi = ::fcntl(in, F_DUPFD, 10), out_hi = ::fcntl(out, F_DUPFD, 10);
    ::close(in);
    ::close(out);
    ::dup2(in_hi, 3);
    ::dup2(out_hi, 4);
    ::close(in_hi);
    ::close(out_hi);
    g_events_fd = ::open(events.c_str(), O_RDONLY);
    gst_init(&argc, &argv);
    mr::ipc::init();

    CHECK("the off-clock message is a stamper message", mr::stamper::is_stamper_message("mrtsstamp-off-clock"));

    // The gate's input egress at 08:51Z: its first video PES 15,742.883 s ahead.
    GstStructure* s = off_clock(0x101, 15742882866000LL, 1);
    mr::stamper::handle_message("mrstamp_busout_40000", "mrtsstamp-off-clock", s);
    gst_structure_free(s);
    std::vector<JsonObject*> ev = take_events();
    JsonObject* p = ev.size() == 1 ? mr::json_get_object(ev[0], "payload") : nullptr;
    CHECK("one event: the plugin event stamp_off_clock",
          ev.size() == 1 && mr::json_get_string(ev[0], "event") == "plugin_event" &&
              mr::json_get_string(ev[0], "channel") == mr::stamper::OFF_CLOCK_EVENT &&
              std::string(mr::stamper::OFF_CLOCK_EVENT) == "stamp_off_clock" && p != nullptr);
    CHECK("its payload names the egress, the PID, how far off in ms and the count",
          p && mr::json_get_string(p, "tee") == "busout_40000" && json_object_get_int_member(p, "pid") == 0x101 &&
              json_object_get_double_member(p, "offsetMs") > 15742882.865 &&
              json_object_get_double_member(p, "offsetMs") < 15742882.867 &&
              json_object_get_int_member(p, "count") == 1);
    unref(ev);

    s = off_clock(-1, 25000000000LL, 7);
    mr::stamper::handle_message("mrstamp_busout_41000", "mrtsstamp-off-clock", s);
    gst_structure_free(s);
    ev = take_events();
    p = ev.size() == 1 ? mr::json_get_object(ev[0], "payload") : nullptr;
    CHECK("a floor reset: PID -1, its 25 s, the count as posted",
          p && mr::json_get_string(p, "tee") == "busout_41000" && json_object_get_int_member(p, "pid") == -1 &&
              json_object_get_double_member(p, "offsetMs") == 25000.0 && json_object_get_int_member(p, "count") == 7);
    unref(ev);

    s = off_clock(0x101, 1, 1);
    mr::stamper::handle_message("tap0", "mrtsstamp-off-clock", s);
    mr::stamper::handle_message("mrstamp_busout_40000", "mrtsstamp-off-clock", nullptr);
    gst_structure_free(s);
    ev = take_events();
    CHECK("from no stamper element, or without a structure: nothing", ev.empty());
    unref(ev);

    s = gst_structure_new("mrtsstamp-segment-warning", "why", G_TYPE_STRING, "no SEGMENT event on the tee sink",
                          nullptr);
    mr::stamper::handle_message("mrstamp_busout_40000", "mrtsstamp-segment-warning", s);
    gst_structure_free(s);
    ev = take_events();
    CHECK("the segment warning is still the runner's warning event",
          ev.size() >= 1 && mr::json_get_string(ev[0], "event") == "warning");
    unref(ev);

    ::close(g_events_fd);
    ::unlink(events.c_str());
    ::rmdir(tmp);
    g_free(tmp);
    return test_summary("stamper_message");
}
