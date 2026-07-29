#include "sps_parse.h"

namespace mrts {

namespace {

// MSB-first bit reader with exp-Golomb decode. Overrun sets `fail` — parsers
// check it and return nullopt (the python version's IndexError contract).
class BitReader {
  public:
    BitReader(const uint8_t* d, size_t n) : d_(d), bits_(n * 8) {}

    uint64_t bits(int count) {
        uint64_t v = 0;
        for (int i = 0; i < count; i++) {
            if (pos_ >= bits_) {
                fail = true;
                return 0;
            }
            v = (v << 1) | ((d_[pos_ >> 3] >> (7 - (pos_ & 7))) & 1);
            pos_++;
        }
        return v;
    }

    void skip(int count) {
        pos_ += count;
        if (pos_ > bits_) fail = true;
    }

    uint32_t ue() {
        int zeros = 0;
        while (!fail && bits(1) == 0) {
            if (++zeros > 31) {                  // exp-Golomb runaway
                fail = true;
                return 0;
            }
        }
        if (fail) return 0;
        return (1u << zeros) - 1 + (zeros ? (uint32_t)bits(zeros) : 0);
    }

    int32_t se() {
        uint32_t k = ue();
        return (k & 1) ? (int32_t)((k + 1) >> 1) : -(int32_t)(k >> 1);
    }

    bool fail = false;

  private:
    const uint8_t* d_;
    size_t bits_;
    size_t pos_ = 0;
};

// Profiles whose SPS carries chroma_format_idc etc. (ISO 14496-10 §7.3.2.1.1).
bool h264_high_profile(uint32_t p) {
    switch (p) {
        case 100: case 110: case 122: case 244: case 44: case 83: case 86:
        case 118: case 128: case 134: case 135: case 138: case 139:
            return true;
        default:
            return false;
    }
}

void skip_h264_scaling_list(BitReader& r, int size) {
    int last = 8, nxt = 8;
    for (int i = 0; i < size && !r.fail; i++) {
        if (nxt != 0) nxt = ((last + r.se()) % 256 + 256) % 256;
        last = nxt != 0 ? nxt : last;
    }
}

}  // namespace

std::vector<uint8_t> strip_ep(const uint8_t* data, size_t n) {
    std::vector<uint8_t> out;
    out.reserve(n);
    size_t i = 0;
    while (i < n) {
        if (i + 2 < n && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 3) {
            out.push_back(0);
            out.push_back(0);
            i += 3;
        } else {
            out.push_back(data[i]);
            i += 1;
        }
    }
    return out;
}

std::optional<SpsInfo> parse_h264_sps(const std::vector<uint8_t>& rbsp) {
    BitReader r(rbsp.data(), rbsp.size());
    uint32_t profile_idc = (uint32_t)r.bits(8);
    r.skip(8);                                  // constraint flags + reserved
    r.skip(8);                                  // level_idc
    r.ue();                                     // seq_parameter_set_id
    uint32_t chroma_format_idc = 1;
    uint32_t separate_colour_plane = 0;
    if (h264_high_profile(profile_idc)) {
        chroma_format_idc = r.ue();
        if (chroma_format_idc == 3) separate_colour_plane = (uint32_t)r.bits(1);
        r.ue();                                 // bit_depth_luma_minus8
        r.ue();                                 // bit_depth_chroma_minus8
        r.skip(1);                              // qpprime_y_zero_transform_bypass
        if (r.bits(1)) {                        // seq_scaling_matrix_present
            int lists = chroma_format_idc == 3 ? 12 : 8;
            for (int i = 0; i < lists && !r.fail; i++)
                if (r.bits(1)) skip_h264_scaling_list(r, i < 6 ? 16 : 64);
        }
    }
    r.ue();                                     // log2_max_frame_num_minus4
    uint32_t pic_order_cnt_type = r.ue();
    if (pic_order_cnt_type == 0) {
        r.ue();                                 // log2_max_pic_order_cnt_lsb_minus4
    } else if (pic_order_cnt_type == 1) {
        r.skip(1);                              // delta_pic_order_always_zero
        r.se();
        r.se();
        uint32_t cycles = r.ue();
        for (uint32_t i = 0; i < cycles && !r.fail; i++) r.se();
    }
    r.ue();                                     // max_num_ref_frames
    r.skip(1);                                  // gaps_in_frame_num_value_allowed
    int pic_width_in_mbs = (int)r.ue() + 1;
    int pic_height_in_map_units = (int)r.ue() + 1;
    uint32_t frame_mbs_only = (uint32_t)r.bits(1);
    if (!frame_mbs_only) r.skip(1);             // mb_adaptive_frame_field
    r.skip(1);                                  // direct_8x8_inference
    int width = pic_width_in_mbs * 16;
    int height = pic_height_in_map_units * 16 * (2 - (int)frame_mbs_only);
    if (r.bits(1)) {                            // frame_cropping
        // Crop units (§7.4.2.1.1): chroma-scaled; vertical doubles when
        // coding fields (frame_mbs_only == 0).
        int cw, ch;
        if (separate_colour_plane || chroma_format_idc == 0) {
            cw = 1;
            ch = 1;
        } else {
            cw = (chroma_format_idc == 1 || chroma_format_idc == 2) ? 2 : 1;
            ch = chroma_format_idc == 1 ? 2 : 1;
        }
        ch *= 2 - (int)frame_mbs_only;
        uint32_t left = r.ue(), right = r.ue(), top = r.ue(), bottom = r.ue();
        width -= (int)(left + right) * cw;
        height -= (int)(top + bottom) * ch;
    }
    std::optional<double> fps;
    if (r.bits(1)) {                            // vui_parameters_present
        if (r.bits(1)) {                        // aspect_ratio_info_present
            if (r.bits(8) == 255) r.skip(32);   // Extended_SAR
        }
        if (r.bits(1)) r.skip(1);               // overscan_info_present
        if (r.bits(1)) {                        // video_signal_type_present
            r.skip(4);                          // format + full_range
            if (r.bits(1)) r.skip(24);          // colour_description_present
        }
        if (r.bits(1)) {                        // chroma_loc_info_present
            r.ue();
            r.ue();
        }
        if (r.bits(1)) {                        // timing_info_present
            uint32_t num_units_in_tick = (uint32_t)r.bits(32);
            uint32_t time_scale = (uint32_t)r.bits(32);
            if (!r.fail && num_units_in_tick)
                fps = (double)time_scale / (2.0 * num_units_in_tick);
        }
    }
    if (r.fail) return std::nullopt;
    return SpsInfo{"h264", width, height, frame_mbs_only == 0, fps};
}

std::optional<SpsInfo> parse_h265_sps(const std::vector<uint8_t>& rbsp) {
    BitReader r(rbsp.data(), rbsp.size());
    r.skip(4);                                  // sps_video_parameter_set_id
    int max_sub_layers = (int)r.bits(3);
    r.skip(1);                                  // sps_temporal_id_nesting
    // profile_tier_level(1, max_sub_layers)
    r.skip(96);                                 // general profile space..level_idc
    bool sub_profile[8] = {};
    bool sub_level[8] = {};
    for (int i = 0; i < max_sub_layers; i++) {
        sub_profile[i] = r.bits(1) != 0;
        sub_level[i] = r.bits(1) != 0;
    }
    if (max_sub_layers > 0)
        for (int i = max_sub_layers; i < 8; i++) r.skip(2);   // reserved alignment
    for (int i = 0; i < max_sub_layers; i++) {
        if (sub_profile[i]) r.skip(88);
        if (sub_level[i]) r.skip(8);
    }
    r.ue();                                     // sps_seq_parameter_set_id
    uint32_t chroma_format_idc = r.ue();
    if (chroma_format_idc == 3) r.skip(1);      // separate_colour_plane
    int width = (int)r.ue();                    // pic_width_in_luma_samples
    int height = (int)r.ue();                   // pic_height_in_luma_samples
    if (r.bits(1)) {                            // conformance_window
        int sub_w = (chroma_format_idc == 1 || chroma_format_idc == 2) ? 2 : 1;
        int sub_h = chroma_format_idc == 1 ? 2 : 1;
        uint32_t left = r.ue(), right = r.ue(), top = r.ue(), bottom = r.ue();
        width -= (int)(left + right) * sub_w;
        height -= (int)(top + bottom) * sub_h;
    }
    if (r.fail) return std::nullopt;
    SpsInfo info{"h265", width, height, false, std::nullopt};
    // Skip-path to VUI timing; any failure past here keeps the geometry
    // (python's inner try/except).
    r.ue();                                     // bit_depth_luma_minus8
    r.ue();                                     // bit_depth_chroma_minus8
    r.ue();                                     // log2_max_pic_order_cnt_lsb_minus4
    uint64_t sub_layer_ordering = r.bits(1);
    for (int i = sub_layer_ordering ? 0 : max_sub_layers;
         i < max_sub_layers + 1 && !r.fail; i++) {
        r.ue();
        r.ue();
        r.ue();
    }
    r.ue();                                     // log2_min_luma_coding_block_size
    r.ue();                                     // log2_diff_max_min_luma_coding_block
    r.ue();                                     // log2_min_luma_transform_block_size
    r.ue();                                     // log2_diff_max_min_luma_transform
    r.ue();                                     // max_transform_hierarchy_depth_inter
    r.ue();                                     // max_transform_hierarchy_depth_intra
    if (r.bits(1) && r.bits(1)) {               // scaling_list_enabled + data_present
        for (int size_id = 0; size_id < 4 && !r.fail; size_id++) {
            int matrices = size_id != 3 ? 6 : 2;
            for (int m = 0; m < matrices && !r.fail; m++) {
                if (!r.bits(1)) {               // pred_mode: 0 = predicted
                    r.ue();                     // scaling_list_pred_matrix_id_delta
                } else {
                    int coefs = 1 << (4 + (size_id << 1));
                    if (coefs > 64) coefs = 64;
                    if (size_id > 1) r.se();    // dc coefficient
                    for (int c = 0; c < coefs && !r.fail; c++) r.se();
                }
            }
        }
    }
    r.skip(2);                                  // amp_enabled + sample_adaptive_offset
    if (r.bits(1)) {                            // pcm_enabled
        r.skip(8);                              // pcm bit depths
        r.ue();
        r.ue();                                 // pcm block sizes
        r.skip(1);                              // pcm_loop_filter_disabled
    }
    uint32_t num_st_rps = r.ue();               // num_short_term_ref_pic_sets
    for (uint32_t i = 0; i < num_st_rps && !r.fail; i++) {
        // st_ref_pic_set(i): inter-prediction form needs NumDeltaPocs of the
        // previous set — not tracked; bail to geometry-only (python parity).
        if (i && r.bits(1)) {                   // inter_ref_pic_set_prediction
            r.skip(1);                          // delta_rps_sign
            r.ue();                             // abs_delta_rps_minus1
            r.fail = true;
            break;
        }
        uint32_t neg = r.ue(), pos = r.ue();
        for (uint32_t j = 0; j < neg + pos && !r.fail; j++) {
            r.ue();
            r.skip(1);
        }
    }
    if (!r.fail && r.bits(1)) {                 // long_term_ref_pics_present
        uint32_t n = r.ue();
        for (uint32_t i = 0; i < n && !r.fail; i++) {
            r.ue();
            r.skip(1);
        }
    }
    r.skip(2);                                  // sps_temporal_mvp + strong_intra_smoothing
    if (!r.fail && r.bits(1)) {                 // vui_parameters_present
        if (r.bits(1)) {                        // aspect_ratio_info_present
            if (r.bits(8) == 255) r.skip(32);
        }
        if (r.bits(1)) r.skip(1);               // overscan_info_present
        if (r.bits(1)) {                        // video_signal_type_present
            r.skip(4);
            if (r.bits(1)) r.skip(24);
        }
        if (r.bits(1)) {                        // chroma_loc_info_present
            r.ue();
            r.ue();
        }
        r.skip(3);                              // neutral_chroma + field_seq + frame_field_info
        if (r.bits(1)) {                        // default_display_window
            r.ue();
            r.ue();
            r.ue();
            r.ue();
        }
        if (r.bits(1)) {                        // vui_timing_info_present
            uint32_t num_units_in_tick = (uint32_t)r.bits(32);
            uint32_t time_scale = (uint32_t)r.bits(32);
            if (!r.fail && num_units_in_tick)
                info.fps = (double)time_scale / num_units_in_tick;
        }
    }
    return info;
}

}  // namespace mrts
