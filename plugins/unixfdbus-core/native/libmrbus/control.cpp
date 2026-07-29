#include "control.h"

#include <errno.h>
#include <time.h>
#include <unistd.h>

#include <cstdio>

namespace mrbus {

int64_t mono_ns() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1'000'000'000 + ts.tv_nsec;
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof buf, "\\u%04x", c);
                    out += buf;
                } else {
                    out += (char)c;
                }
        }
    }
    return out;
}

bool emit_line(const std::string& json) {
    std::string line = json + "\n";
    size_t off = 0;
    while (off < line.size()) {
        ssize_t n = write(STDOUT_FILENO, line.data() + off, line.size() - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;   // stdout gone — engine died
        }
        off += (size_t)n;
    }
    return true;
}

namespace {

void skip_ws(const std::string& s, size_t& i) {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r')) i++;
}

bool parse_string(const std::string& s, size_t& i, std::string& out) {
    if (i >= s.size() || s[i] != '"') return false;
    i++;
    out.clear();
    while (i < s.size() && s[i] != '"') {
        if (s[i] == '\\' && i + 1 < s.size()) {
            i++;
            switch (s[i]) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case 'u':
                    if (i + 4 >= s.size()) return false;
                    // Control-verb strings are ASCII paths/names; a non-ASCII
                    // escape is preserved verbatim rather than decoded.
                    out += "\\u" + s.substr(i + 1, 4);
                    i += 4;
                    break;
                default: out += s[i];
            }
            i++;
        } else {
            out += s[i++];
        }
    }
    if (i >= s.size()) return false;
    i++;   // closing quote
    return true;
}

}  // namespace

bool parse_flat_json(const std::string& line, std::map<std::string, std::string>& out) {
    out.clear();
    size_t i = 0;
    skip_ws(line, i);
    if (i >= line.size() || line[i] != '{') return false;
    i++;
    skip_ws(line, i);
    if (i < line.size() && line[i] == '}') return true;
    while (true) {
        skip_ws(line, i);
        std::string key, val;
        if (!parse_string(line, i, key)) return false;
        skip_ws(line, i);
        if (i >= line.size() || line[i] != ':') return false;
        i++;
        skip_ws(line, i);
        if (i < line.size() && line[i] == '"') {
            if (!parse_string(line, i, val)) return false;
        } else {
            size_t start = i;
            while (i < line.size() && line[i] != ',' && line[i] != '}' &&
                   line[i] != ' ' && line[i] != '\t')
                i++;
            if (i == start) return false;
            val = line.substr(start, i - start);   // number / true / false / null
        }
        out[key] = val;
        skip_ws(line, i);
        if (i >= line.size()) return false;
        if (line[i] == ',') {
            i++;
            continue;
        }
        if (line[i] == '}') return true;
        return false;
    }
}

bool LineReader::read_lines(int fd, std::vector<std::string>& lines) {
    char buf[65536];
    while (true) {
        ssize_t n = read(fd, buf, sizeof buf);
        if (n < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            return false;
        }
        if (n == 0) return false;   // EOF — controller closed stdin
        buf_.append(buf, (size_t)n);
        if ((size_t)n < sizeof buf) break;
    }
    size_t pos;
    while ((pos = buf_.find('\n')) != std::string::npos) {
        lines.push_back(buf_.substr(0, pos));
        buf_.erase(0, pos + 1);
    }
    return true;
}

}  // namespace mrbus
