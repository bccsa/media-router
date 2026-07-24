#!/usr/bin/env python3
"""H.264 / H.265 SPS field parsing — pure bitstream, no TS/GStreamer.

Exp-Golomb-decodes just enough of an SPS RBSP to report resolution, frame
rate and scan type. Consumed by ts_video_info.py (which owns the TS/PES side
and the probe state machine).

Scope: H.264 (NAL 7) and H.265 (NAL 33). All parsers return None on any
malformed input — bitstream bytes are wire data, never trusted. Callers MUST
strip_ep() the RBSP first: parsing with emulation-prevention bytes in place
yields plausible-but-wrong values.
"""
from __future__ import annotations


def strip_ep(data: bytes) -> bytes:
    """Remove emulation-prevention bytes (00 00 03 -> 00 00). MANDATORY before
    reading SPS fields: skipping it yields plausible-but-wrong geometry."""
    if b"\x00\x00\x03" not in data:
        return data
    out = bytearray()
    i = 0
    n = len(data)
    while i < n:
        if i + 2 < n and data[i] == 0 and data[i + 1] == 0 and data[i + 2] == 3:
            out += data[i:i + 2]
            i += 3
        else:
            out.append(data[i])
            i += 1
    return bytes(out)


class BitReader:
    """MSB-first bit reader with exp-Golomb decode. Raises IndexError on
    overrun — parsers catch it and return None."""

    def __init__(self, data: bytes):
        self._d = data
        self._pos = 0                       # bit position

    def bits(self, n: int) -> int:
        v = 0
        for _ in range(n):
            byte = self._d[self._pos >> 3]  # IndexError on overrun
            v = (v << 1) | ((byte >> (7 - (self._pos & 7))) & 1)
            self._pos += 1
        return v

    def ue(self) -> int:
        zeros = 0
        while self.bits(1) == 0:
            zeros += 1
            if zeros > 31:
                raise IndexError("exp-Golomb runaway")
        return (1 << zeros) - 1 + (self.bits(zeros) if zeros else 0)

    def se(self) -> int:
        k = self.ue()
        return (k + 1) >> 1 if k & 1 else -(k >> 1)


# Profiles whose SPS carries chroma_format_idc etc. (ISO 14496-10 §7.3.2.1.1).
_H264_HIGH_PROFILES = frozenset({100, 110, 122, 244, 44, 83, 86, 118, 128, 134, 135, 138, 139})


def _skip_h264_scaling_list(r: BitReader, size: int) -> None:
    last, nxt = 8, 8
    for _ in range(size):
        if nxt != 0:
            nxt = (last + r.se() + 256) % 256
        last = nxt if nxt != 0 else last


def parse_h264_sps(rbsp: bytes):
    """Parse an H.264 SPS RBSP (emulation-prevention already stripped, NAL
    header byte removed). Returns {width, height, interlaced, fps} or None.
    fps = time_scale / (2 * num_units_in_tick) — the coded FRAME rate; for
    interlaced content the display string shows the field rate (2x)."""
    try:
        r = BitReader(rbsp)
        profile_idc = r.bits(8)
        r.bits(8)                            # constraint flags + reserved
        r.bits(8)                            # level_idc
        r.ue()                               # seq_parameter_set_id
        chroma_format_idc = 1
        separate_colour_plane = 0
        if profile_idc in _H264_HIGH_PROFILES:
            chroma_format_idc = r.ue()
            if chroma_format_idc == 3:
                separate_colour_plane = r.bits(1)
            r.ue()                           # bit_depth_luma_minus8
            r.ue()                           # bit_depth_chroma_minus8
            r.bits(1)                        # qpprime_y_zero_transform_bypass
            if r.bits(1):                    # seq_scaling_matrix_present
                for i in range(12 if chroma_format_idc == 3 else 8):
                    if r.bits(1):
                        _skip_h264_scaling_list(r, 16 if i < 6 else 64)
        r.ue()                               # log2_max_frame_num_minus4
        pic_order_cnt_type = r.ue()
        if pic_order_cnt_type == 0:
            r.ue()                           # log2_max_pic_order_cnt_lsb_minus4
        elif pic_order_cnt_type == 1:
            r.bits(1)                        # delta_pic_order_always_zero
            r.se(); r.se()
            for _ in range(r.ue()):
                r.se()
        r.ue()                               # max_num_ref_frames
        r.bits(1)                            # gaps_in_frame_num_value_allowed
        pic_width_in_mbs = r.ue() + 1
        pic_height_in_map_units = r.ue() + 1
        frame_mbs_only = r.bits(1)
        if not frame_mbs_only:
            r.bits(1)                        # mb_adaptive_frame_field
        r.bits(1)                            # direct_8x8_inference
        width = pic_width_in_mbs * 16
        height = pic_height_in_map_units * 16 * (2 - frame_mbs_only)
        if r.bits(1):                        # frame_cropping
            # Crop units (§7.4.2.1.1): chroma-scaled; vertical doubles when
            # coding fields (frame_mbs_only == 0).
            if separate_colour_plane or chroma_format_idc == 0:
                cw, ch = 1, 1
            else:
                cw = 2 if chroma_format_idc in (1, 2) else 1
                ch = 2 if chroma_format_idc == 1 else 1
            ch *= 2 - frame_mbs_only
            left, right, top, bottom = r.ue(), r.ue(), r.ue(), r.ue()
            width -= (left + right) * cw
            height -= (top + bottom) * ch
        fps = None
        if r.bits(1):                        # vui_parameters_present
            if r.bits(1):                    # aspect_ratio_info_present
                if r.bits(8) == 255:         # Extended_SAR
                    r.bits(32)
            if r.bits(1):                    # overscan_info_present
                r.bits(1)
            if r.bits(1):                    # video_signal_type_present
                r.bits(4)                    # format + full_range
                if r.bits(1):                # colour_description_present
                    r.bits(24)
            if r.bits(1):                    # chroma_loc_info_present
                r.ue(); r.ue()
            if r.bits(1):                    # timing_info_present
                num_units_in_tick = r.bits(32)
                time_scale = r.bits(32)
                if num_units_in_tick:
                    fps = time_scale / (2 * num_units_in_tick)
        return {"codec": "h264", "width": width, "height": height,
                "interlaced": not frame_mbs_only, "fps": fps}
    except (IndexError, ValueError):
        return None


def parse_h265_sps(rbsp: bytes):
    """Parse an H.265 SPS RBSP (stripped, 2-byte NAL header removed). Returns
    {width, height, interlaced: False, fps} or None. Geometry parses up to the
    conformance window; fps needs the skip-path to VUI — any failure there
    degrades to fps=None rather than discarding the geometry. HEVC interlace
    is SEI-signalled and effectively unused in broadcast: reported progressive."""
    try:
        r = BitReader(rbsp)
        r.bits(4)                            # sps_video_parameter_set_id
        max_sub_layers = r.bits(3)
        r.bits(1)                            # sps_temporal_id_nesting
        # profile_tier_level(1, max_sub_layers)
        r.bits(96)                           # general profile space..level_idc
        sub_profile = [False] * max_sub_layers
        sub_level = [False] * max_sub_layers
        for i in range(max_sub_layers):
            sub_profile[i] = bool(r.bits(1))
            sub_level[i] = bool(r.bits(1))
        if max_sub_layers > 0:
            for _ in range(max_sub_layers, 8):
                r.bits(2)                    # reserved alignment
        for i in range(max_sub_layers):
            if sub_profile[i]:
                r.bits(88)
            if sub_level[i]:
                r.bits(8)
        r.ue()                               # sps_seq_parameter_set_id
        chroma_format_idc = r.ue()
        if chroma_format_idc == 3:
            r.bits(1)                        # separate_colour_plane
        width = r.ue()                       # pic_width_in_luma_samples
        height = r.ue()                      # pic_height_in_luma_samples
        if r.bits(1):                        # conformance_window
            sub_w = 2 if chroma_format_idc in (1, 2) else 1
            sub_h = 2 if chroma_format_idc == 1 else 1
            left, right, top, bottom = r.ue(), r.ue(), r.ue(), r.ue()
            width -= (left + right) * sub_w
            height -= (top + bottom) * sub_h
        info = {"codec": "h265", "width": width, "height": height,
                "interlaced": False, "fps": None}
        # Skip-path to VUI timing; failure past here keeps the geometry.
        try:
            r.ue()                           # bit_depth_luma_minus8
            r.ue()                           # bit_depth_chroma_minus8
            r.ue()                           # log2_max_pic_order_cnt_lsb_minus4
            sub_layer_ordering = r.bits(1)
            for _ in range(0 if sub_layer_ordering else max_sub_layers,
                           max_sub_layers + 1):
                r.ue(); r.ue(); r.ue()
            r.ue()                           # log2_min_luma_coding_block_size
            r.ue()                           # log2_diff_max_min_luma_coding_block
            r.ue()                           # log2_min_luma_transform_block_size
            r.ue()                           # log2_diff_max_min_luma_transform
            r.ue()                           # max_transform_hierarchy_depth_inter
            r.ue()                           # max_transform_hierarchy_depth_intra
            if r.bits(1) and r.bits(1):      # scaling_list_enabled + data_present
                for size_id in range(4):
                    for _ in range(6 if size_id != 3 else 2):
                        if not r.bits(1):    # pred_mode: 0 = predicted
                            r.ue()           # scaling_list_pred_matrix_id_delta
                        else:
                            coefs = min(64, 1 << (4 + (size_id << 1)))
                            if size_id > 1:
                                r.se()       # dc coefficient
                            for _ in range(coefs):
                                r.se()
            r.bits(2)                        # amp_enabled + sample_adaptive_offset
            if r.bits(1):                    # pcm_enabled
                r.bits(8)                    # pcm bit depths
                r.ue(); r.ue()               # pcm block sizes
                r.bits(1)                    # pcm_loop_filter_disabled
            for i in range(r.ue()):          # num_short_term_ref_pic_sets
                # st_ref_pic_set(i): inter-prediction form only valid for i>0
                if i and r.bits(1):          # inter_ref_pic_set_prediction
                    r.bits(1)                # delta_rps_sign
                    r.ue()                   # abs_delta_rps_minus1
                    # needs NumDeltaPocs of the previous set to walk the flag
                    # loop - not tracked; bail to geometry-only.
                    raise IndexError("st_ref_pic_set inter form")
                else:
                    neg, pos = r.ue(), r.ue()
                    for _ in range(neg + pos):
                        r.ue(); r.bits(1)
            if r.bits(1):                    # long_term_ref_pics_present
                for _ in range(r.ue()):
                    r.ue(); r.bits(1)
            r.bits(2)                        # sps_temporal_mvp + strong_intra_smoothing
            if r.bits(1):                    # vui_parameters_present
                if r.bits(1):                # aspect_ratio_info_present
                    if r.bits(8) == 255:
                        r.bits(32)
                if r.bits(1):                # overscan_info_present
                    r.bits(1)
                if r.bits(1):                # video_signal_type_present
                    r.bits(4)
                    if r.bits(1):
                        r.bits(24)
                if r.bits(1):                # chroma_loc_info_present
                    r.ue(); r.ue()
                r.bits(3)                    # neutral_chroma + field_seq + frame_field_info
                if r.bits(1):                # default_display_window
                    r.ue(); r.ue(); r.ue(); r.ue()
                if r.bits(1):                # vui_timing_info_present
                    num_units_in_tick = r.bits(32)
                    time_scale = r.bits(32)
                    if num_units_in_tick:
                        info["fps"] = time_scale / num_units_in_tick
        except (IndexError, ValueError):
            pass
        return info
    except (IndexError, ValueError):
        return None

