# Rig consumer: unixfd client on the muxer's output edge. Counts buffers/bytes,
# video AUs, and KLV PES on PID 0x1f0 (present? PTS advancing?). Prints one summary line.
import os, sys, time, gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'mpegts-core', 'py'))
import ts_psi
Gst.init([])
sock, secs = sys.argv[1], float(sys.argv[2])
st = {'bufs': 0, 'bytes': 0, 'video': 0, 'klv': 0, 'klv_pts': [], 'klv_nopts': 0, 'first': None}
def cb(sink):
    s = sink.emit('pull-sample'); buf = s.get_buffer(); data = buf.extract_dup(0, buf.get_size())
    if st['first'] is None: st['first'] = time.time()
    st['bufs'] += 1; st['bytes'] += len(data)
    for pkt in ts_psi.iter_packets(data):
        if not ts_psi.ts_has_payload(pkt) or not (pkt[1] & 0x40): continue
        off = ts_psi.payload_offset(pkt); pl = pkt[off:]
        if len(pl) < 9 or pl[:3] != b'\x00\x00\x01': continue
        pid = ts_psi.ts_pid(pkt)
        if 0xE0 <= pl[3] <= 0xEF: st['video'] += 1
        elif pid == 0x1f0:
            st['klv'] += 1
            pts = ts_psi.read_pes_pts(pkt)
            if pts is None: st['klv_nopts'] += 1
            else: st['klv_pts'].append(pts)
    return Gst.FlowReturn.OK
p = Gst.parse_launch(f'unixfdsrc socket-path={sock} ! appsink name=s sync=false emit-signals=true max-buffers=64 drop=true')
p.get_by_name('s').connect('new-sample', cb); p.set_state(Gst.State.PLAYING)
loop = GLib.MainLoop(); GLib.timeout_add(int(secs * 1000), lambda: (loop.quit(), False)[1]); loop.run()
p.set_state(Gst.State.NULL)
el = (time.time() - st['first']) if st['first'] else secs
k = st['klv_pts']; span = ((k[-1] - k[0]) / 90.0) if len(k) > 1 else 0
mono = all(b >= a for a, b in zip(k, k[1:])) if len(k) > 1 else True
print(f"    OUTPUT: {st['bufs']/el:.0f} buf/s, {st['bytes']*8/el/1000:.0f} kbps, video {st['video']/el:.1f} AU/s, "
      f"KLV {st['klv']/el:.1f} PES/s (no-PTS {st['klv_nopts']}, PTS span {span:.0f} ms over {el:.0f} s, monotonic={mono})")
