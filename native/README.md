# native/ — Native media-router components

C++17 ports of media-router's performance-critical data paths. Zero third-party
dependencies (libc/libstdc++ only), plain Makefiles, no code generation, no
network access during build — any packaging system can consume the standard
`make` / `make install` contract directly.

## Layout

| Directory | What | Portability |
|---|---|---|
| `mrts/` | MPEG-TS packet core: PSI parse/build + discovery (`ts_psi`), the packet-level splitter (`ts_split`), H.264/H.265 SPS probe (`ts_video_info`, `sps_parse`), and the `mrts_cli` test harness | Any platform with a C++17 compiler (Linux, macOS, …) |

`mrts` is a byte-for-byte behavioral port of the Python reference modules in
`packages/engine/src/child-process/` (`ts_split.py`, `ts_psi.py`,
`ts_video_info.py`, `sps_parse.py`). The Python versions are the executable
specification: the golden parity test
(`packages/engine/src/child-process/nativeSplitParity.test.ts`) drives both
implementations over the same input and requires identical output bytes.

## Building

```sh
make -C native            # build everything
make -C native test       # build + run the C++ unit tests
make -C native install    # install binaries to $(DESTDIR)$(PREFIX)/bin
```

Standard variables are honored: `CXX`, `CXXFLAGS`, `AR`, `DESTDIR`,
`PREFIX` (default `/usr/local`). Cross-compile by setting `CXX`, e.g.:

```sh
make -C native CXX=aarch64-linux-gnu-g++
```

`native/build-host.sh` builds just the portable core with the host toolchain —
this is what the vitest parity suite invokes; the suite skips gracefully when
no C++ compiler or python3 is available.

## Testing

- `make -C native test` — self-contained C++ unit tests (ported from the
  `*_test.py` scripts alongside the Python modules).
- `pnpm test` from the repo root — includes the cross-language golden parity
  suite, which generates a deterministic synthetic MPTS (PCR jitter, desync
  garbage, descriptor-identified codecs, mid-stream codec change), runs it
  through the Python core and the native core with identical chunking, and
  compares every output PID byte-for-byte.
