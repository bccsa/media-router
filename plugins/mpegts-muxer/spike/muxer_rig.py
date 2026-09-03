#!/usr/bin/env python3
"""Local muxer rig: two producers (video x264 8 Mbps CBR, audio AAC) with the
coalescing egress -> the REAL gst-pipeline-runner.py running the muxer's exact
pipeline/rules -> one attached consumer edge. Measures the runner's per-thread
CPU over a window and counts GstBus messages (GST_DEBUG=GST_BUS:5 on the
runner) so the main-thread cost can be attributed."""
import json, os, re, subprocess, sys, time, collections

S = os.path.dirname(os.path.abspath(__file__))          # spike dir: rig-*.json / rig-*.err live here
MR = os.path.normpath(os.path.join(S, '..', '..', '..'))    # repo root
SO = f'{MR}/plugins/mpegts-core/native/mrtsstamp/libgstmrtsstamp.so'
RUNNER = f'{MR}/packages/engine/src/child-process/gst-pipeline-runner.py'
CAPS = 'video/mpegts,systemstream=(boolean)true,packetsize=(int)188'
EGRESS = (f'mrtsstamp coalesce=true active=true ! capssetter caps="{CAPS}" replace=true ! capsfilter caps="{CAPS}" '
          '! tee name=t allow-not-linked=true t. ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0 ! unixfdsink sync=false socket-path=')
VIDEO = ('videotestsrc is-live=true pattern=snow ! video/x-raw,width=1280,height=720,framerate=25/1 ! x264enc pass=cbr bitrate=8000 tune=zerolatency speed-preset=ultrafast key-int-max=50 ! h264parse ! mpegtsmux alignment=7 ! ' + EGRESS + '/tmp/rig-video.sock')
AUDIO = ('audiotestsrc is-live=true ! audio/x-raw,rate=48000,channels=2 ! avenc_aac bitrate=128000 ! aacparse ! mpegtsmux alignment=7 ! ' + EGRESS + '/tmp/rig-audio.sock')

def ticks(t): return sum(int(x) for x in open(f'{t}/stat').read().rsplit(')', 1)[1].split()[11:13])
def ctxt(t): return sum(int(l.split()[1]) for l in open(f'{t}/status') if 'ctxt_switches' in l)
def snap(pid): return {os.path.basename(t): (open(f'{t}/comm').read().strip(), ticks(t), ctxt(t)) for t in [f'/proc/{pid}/task/{x}' for x in os.listdir(f'/proc/{pid}/task')]}

def run(name, desc_file, drop=(), bus_debug=False, window=10):
    for f in ('/tmp/rig-video.sock', '/tmp/rig-audio.sock', '/tmp/rig-out.sock'):
        try: os.unlink(f)
        except FileNotFoundError: pass
    prods = [subprocess.Popen(['gst-launch-1.0', f'--gst-plugin-load={SO}', '-q'] + P.split(' ! ') if False else
                              ['bash', '-c', f'exec gst-launch-1.0 --gst-plugin-load={SO} -q {P}'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for P in (VIDEO, AUDIO)]
    time.sleep(2.5)
    d = json.load(open(desc_file))
    if os.environ.get('MUX_PROPS') is not None:
        d['pipeline'] = d['pipeline'].replace('latency=1200000000 min-upstream-latency=1200000000', os.environ['MUX_PROPS'])
        print(f'    mux props: "{os.environ["MUX_PROPS"]}"')
    if os.environ.get('KLV_PROPS'):
        d['pipeline'] = d['pipeline'].replace('appsrc name=klvsrc is-live=true', 'appsrc name=klvsrc is-live=true ' + os.environ['KLV_PROPS'])
        print(f'    klvsrc extra props: "{os.environ["KLV_PROPS"]}"')
    if os.environ.get('PIPE_SED'):
        old, new = os.environ['PIPE_SED'].split('||', 1)
        assert old in d['pipeline'], f'PIPE_SED: {old!r} not in pipeline'
        d['pipeline'] = d['pipeline'].replace(old, new)
        print(f'    pipeline edit: {old!r} -> {new!r}')
    start = {'cmd': 'start', 'pipeline': d['pipeline'], 'useStdioForData': False, 'restartOnError': False,
             'linkOnPadAdded': d['linkOnPadAdded'], 'timeSyncContract': True,
             'alignBranchesToStamps': {'demuxes': d['demuxes']}, 'inputStallWatch': d['inputStallWatch']}
    for k in drop: start.pop(k, None)
    env = dict(os.environ, PYTHONPATH=f'{MR}/plugins/mpegts-core/py:{MR}/plugins/unixfdbus-core/py', MR_PLUGINS_DIR=f'{MR}/plugins')
    if bus_debug: env['GST_DEBUG'] = 'GST_BUS:5'
    errf = open(f'{S}/rig-{name}.err', 'w')
    r = subprocess.Popen([sys.executable, RUNNER], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errf, env=env, text=True, bufsize=1)
    def cmd(o): r.stdin.write(json.dumps(o) + '\n'); r.stdin.flush()
    cmd(start); time.sleep(1.0)
    if d.get('hasStreamInfo') and 'klv' in name:
        cmd({'cmd': 'set_klv_payload', 'element': 'klvsrc', 'payload': json.dumps({'v': 1, 'streams': [{'pid': 256, 'media': 'video', 'name': 'Cam'}, {'pid': 320, 'media': 'audio', 'name': 'Mix'}]})})
    cmd({'cmd': 'bus_attach', 'tee': 'busout_40002', 'socket': '/tmp/rig-out.sock'}); time.sleep(1.0)
    cons = subprocess.Popen([sys.executable, f'{S}/rig_tap.py', '/tmp/rig-out.sock', str(20 + window + 2)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    time.sleep(20)                       # let branch alignment settle (3-15 s)
    err_before = os.path.getsize(f'{S}/rig-{name}.err')
    s1 = snap(r.pid); time.sleep(window); s2 = snap(r.pid)
    err_after = os.path.getsize(f'{S}/rig-{name}.err')
    print(f'=== {name}  (dropped: {list(drop) or "-"})')
    rows = []
    for tid, (comm, tk, cx) in s2.items():
        if tid in s1:
            dt, dc = tk - s1[tid][1], (cx - s1[tid][2]) / window
            if dt >= 2 or dc >= 30: rows.append((dt, comm, dc))
    for dt, comm, dc in sorted(rows, reverse=True): print(f'    {comm:22s} {dt:4d} ticks/{window}s  {dc:6.0f} wk/s')
    print(f'    TOTAL {sum(v[1] for v in s2.values()) - sum(v[1] for v in s1.values())} ticks/{window}s')
    if bus_debug:
        with open(f'{S}/rig-{name}.err', 'rb') as fh:
            fh.seek(err_before); txt = fh.read(err_after - err_before).decode(errors='replace')
        c = collections.Counter()
        for m in re.finditer(r"gst_bus_post:<bus0>.*?posting on bus (\S+) message.*?element '([^']+)'", txt):
            c[f'{m.group(1)} from {m.group(2)}'] += 1
        tot = sum(c.values()); print(f'    bus messages: {tot} in {window}s ({tot/window:.0f}/s)')
        for k, v in c.most_common(8): print(f'       {v/window:6.1f}/s  {k}')
        w = collections.Counter(re.findall(r'Impossible to configure latency: max ([0-9:.]+) \\?< min ([0-9:.]+)', txt))
        for (mx, mn), v in w.most_common(2): print(f'       warning text: max {mx} < min {mn}  (x{v})')
        n = sum(1 for _ in txt.splitlines()); print(f'    (stderr lines in window: {n})')
    try: print(cons.communicate(timeout=20)[0].rstrip())
    except Exception as e: print('    tap:', e)
    cmd({'cmd': 'stop'}); time.sleep(1.5)
    for p in (r, cons, *prods):
        try: p.terminate(); p.wait(3)
        except Exception: p.kill()
    errf.close()

if __name__ == '__main__':
    which = sys.argv[1:] or ['klv-bus', 'klv', 'noklv', 'noalign']
    for w in which:
        if w == 'klv-bus': run('klv-bus', f'{S}/rig-klv.json', bus_debug=True)
        elif w == 'klv': run('klv', f'{S}/rig-klv.json')
        elif w == 'noklv': run('noklv', f'{S}/rig-noklv.json')
        elif w == 'noalign': run('noalign-klv', f'{S}/rig-klv.json', drop=('alignBranchesToStamps',))
        elif w == 'nostall': run('nostall-klv', f'{S}/rig-klv.json', drop=('inputStallWatch',))
