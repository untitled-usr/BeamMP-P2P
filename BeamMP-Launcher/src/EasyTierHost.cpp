/*
 Copyright (C) 2024 BeamMP Ltd., BeamMP team and contributors.
 Licensed under AGPL-3.0 (or later), see <https://www.gnu.org/licenses/>.
 SPDX-License-Identifier: AGPL-3.0-or-later
*/

#include "EasyTierHost.h"
#include "Logger.h"
#include "RoomHost.h"
#include "Startup.h"

#include <cctype>
#include <chrono>
#include <iomanip>
#include <mutex>
#include <random>
#include <sstream>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <nlohmann/json.hpp>
#include <openssl/rand.h>
#include <openssl/sha.h>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <csignal>
#include <fcntl.h>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/prctl.h>
#endif
#endif

namespace fs = std::filesystem;

extern std::string Username;

namespace EasyTierHost {

static std::mutex g_etMutex;
constexpr const char* kDefaultRpcPortal = "127.0.0.1:15888";

struct EtSession {
    std::string rpcPortal { kDefaultRpcPortal };
#if defined(_WIN32)
    PROCESS_INFORMATION proc {};
    bool hasProc { false };
#else
    pid_t pid { -1 };
#endif
};

static std::unordered_map<std::string, EtSession> g_sessions;

namespace {
constexpr const char* kHostSession = "host";
constexpr const char* kGuestSession = "guest";
}

namespace {

#if defined(_WIN32)
static std::string Win32QuoteArg(std::string_view inner) {
    std::string escaped;
    escaped.reserve(inner.size() + 4);
    for (char c : inner) {
        if (c == '"')
            escaped += "\"\"";
        else
            escaped.push_back(c);
    }
    return std::string("\"") + escaped + "\"";
}

static std::string Win32CmdMergedFlag(std::string_view flagName, const std::string& value) {
    std::string inner;
    inner.append("--");
    inner.append(flagName);
    inner.push_back('=');
    inner.append(value);
    return Win32QuoteArg(inner);
}
#endif

static std::string TrimAsciiWs(std::string s) {
    size_t b = 0;
    while (b < s.size() && std::isspace(static_cast<unsigned char>(s[b])) != 0)
        ++b;
    size_t e = s.size();
    while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1])) != 0)
        --e;
    if (b == 0 && e == s.size())
        return s;
    return s.substr(b, e - b);
}

static std::vector<std::string> ParsePeerList(std::string_view raw) {
    std::vector<std::string> out;
    std::unordered_set<std::string> seen;
    std::string token;
    token.reserve(raw.size());

    auto flush = [&]() {
        std::string t = TrimAsciiWs(token);
        token.clear();
        if (t.empty())
            return;
        // Better UX: allow host:port and default to tcp://
        if (t.find("://") == std::string::npos)
            t = "tcp://" + t;
        if (seen.insert(t).second)
            out.push_back(std::move(t));
    };

    const unsigned char* bytes = reinterpret_cast<const unsigned char*>(raw.data());
    const size_t n = raw.size();
    for (size_t i = 0; i < n; ++i) {
        // UTF-8 delimiters: fullwidth comma/semicolon and ideographic comma
        if (i + 2 < n && bytes[i] == 0xEF && bytes[i + 1] == 0xBC && (bytes[i + 2] == 0x8C || bytes[i + 2] == 0x9B)) {
            flush();
            i += 2;
            continue;
        }
        if (i + 2 < n && bytes[i] == 0xE3 && bytes[i + 1] == 0x80 && bytes[i + 2] == 0x81) {
            flush();
            i += 2;
            continue;
        }
        const unsigned char c = bytes[i];
        if (c == ',' || c == ';' || std::isspace(c) != 0) {
            flush();
            continue;
        }
        token.push_back(static_cast<char>(c));
    }
    flush();
    return out;
}

static std::string JoinForLog(const std::vector<std::string>& arr) {
    std::string out;
    for (size_t i = 0; i < arr.size(); ++i) {
        if (i)
            out += ", ";
        out += arr[i];
    }
    return out;
}

static bool JsonIsEmptyValue(const nlohmann::json& v) {
    if (v.is_null())
        return true;
    if (v.is_string())
        return v.get_ref<const std::string&>().empty();
    if (v.is_array() || v.is_object())
        return v.empty();
    return false;
}

static void JsonMergeMissing(nlohmann::json& dst, const nlohmann::json& src) {
    if (!src.is_object()) {
        if (JsonIsEmptyValue(dst) && !JsonIsEmptyValue(src))
            dst = src;
        return;
    }
    if (!dst.is_object()) {
        if (JsonIsEmptyValue(dst))
            dst = src;
        return;
    }
    for (auto it = src.begin(); it != src.end(); ++it) {
        const auto& key = it.key();
        const auto& val = it.value();
        if (!dst.contains(key)) {
            dst[key] = val;
            continue;
        }
        auto& cur = dst[key];
        if (cur.is_object() && val.is_object()) {
            JsonMergeMissing(cur, val);
            continue;
        }
        if (JsonIsEmptyValue(cur) && !JsonIsEmptyValue(val))
            cur = val;
    }
}

} // namespace

static EtSession& GetSessionUnlocked(const std::string& sessionId) {
    auto [it, inserted] = g_sessions.try_emplace(sessionId, EtSession {});
    if (inserted && sessionId == kGuestSession)
        it->second.rpcPortal = "127.0.0.1:15889";
    return it->second;
}

static void stopCoreImpl(EtSession& s) {
#if defined(_WIN32)
    if (s.hasProc) {
        DWORD pid = GetProcessId(s.proc.hProcess);
        if (pid != 0) {
            if (GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid)) {
                DWORD w = WaitForSingleObject(s.proc.hProcess, 1500);
                if (w == WAIT_TIMEOUT)
                    TerminateProcess(s.proc.hProcess, 1);
            } else {
                TerminateProcess(s.proc.hProcess, 1);
            }
        } else {
            TerminateProcess(s.proc.hProcess, 1);
        }
        CloseHandle(s.proc.hProcess);
        s.proc.hProcess = nullptr;
        s.proc.hThread = nullptr;
        s.hasProc = false;
    }
#else
    if (s.pid > 0) {
        kill(s.pid, SIGTERM);
        int st = 0;
        waitpid(s.pid, &st, 0);
        s.pid = -1;
    }
#endif
}

static bool isCoreRunningImpl(EtSession& s) {
#if defined(_WIN32)
    if (!s.hasProc)
        return false;
    DWORD code = STILL_ACTIVE;
    if (GetExitCodeProcess(s.proc.hProcess, &code) && code == STILL_ACTIVE)
        return true;
    CloseHandle(s.proc.hProcess);
    CloseHandle(s.proc.hThread);
    ZeroMemory(&s.proc, sizeof(s.proc));
    s.hasProc = false;
    return false;
#else
    if (s.pid <= 0)
        return false;
    int st = 0;
    pid_t r = waitpid(s.pid, &st, WNOHANG);
    if (r == 0)
        return true;
    s.pid = -1;
    return false;
#endif
}

fs::path CoreExecutable() {
    fs::path bp = GetBP();
#if defined(_WIN32)
    return bp / "easytier-core.exe";
#else
    return bp / "easytier-core";
#endif
}

fs::path CliExecutable() {
    fs::path bp = GetBP();
#if defined(_WIN32)
    return bp / "easytier-cli.exe";
#else
    return bp / "easytier-cli";
#endif
}

std::string Sha256Hex(std::string_view data) {
    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(data.data()), data.size(), hash);
    static const char* hex = "0123456789abcdef";
    std::string out;
    out.resize(SHA256_DIGEST_LENGTH * 2);
    for (size_t i = 0; i < SHA256_DIGEST_LENGTH; ++i) {
        out[i * 2] = hex[hash[i] >> 4];
        out[i * 2 + 1] = hex[hash[i] & 0xf];
    }
    return out;
}

std::string BuildNetworkName(const std::string& displayName) {
    std::string h = Sha256Hex(displayName);
    if (h.size() < 16)
        return "beammp-p2p-room-error";
    return "beammp-p2p-room-" + h.substr(0, 16);
}

std::string BuildNetworkSecret(const std::string& password) {
    std::string h = Sha256Hex(password);
    if (h.size() < 32)
        return h;
    return h.substr(0, 32);
}

std::string SanitizeUsernameSegment(const std::string& username) {
    std::string s;
    for (unsigned char c : username) {
        if (std::isalnum(c))
            s.push_back(static_cast<char>(std::tolower(c)));
        else if (c == '-' || c == '_')
            s.push_back(static_cast<char>(c));
        else
            s.push_back('_');
    }
    if (s.empty())
        s = "user";
    if (s.size() > 32)
        s.resize(32);
    return s;
}

std::string BuildHostHostname(const std::string& launcherUsername) {
    std::string u = SanitizeUsernameSegment(launcherUsername.empty() ? std::string("user") : launcherUsername);
    unsigned char rnd[4];
    if (RAND_bytes(rnd, static_cast<int>(sizeof(rnd))) != 1) {
        std::random_device rd;
        for (unsigned char& b : rnd)
            b = static_cast<unsigned char>(rd());
    }
    std::stringstream ss;
    ss << std::hex << std::setfill('0');
    for (unsigned char b : rnd)
        ss << std::setw(2) << static_cast<int>(b);
    std::string suf = ss.str();
    if (suf.size() > 6)
        suf = suf.substr(0, 6);
    return "host-" + u + "-" + suf;
}

std::string BuildGuestHostname(const std::string& launcherUsername) {
    std::string u = SanitizeUsernameSegment(launcherUsername.empty() ? std::string("user") : launcherUsername);
    unsigned char rnd[16];
    if (RAND_bytes(rnd, static_cast<int>(sizeof(rnd))) != 1) {
        std::random_device rd;
        for (unsigned char& b : rnd)
            b = static_cast<unsigned char>(rd());
    }
    rnd[6] = static_cast<unsigned char>((rnd[6] & 0x0F) | 0x40); // uuid v4
    rnd[8] = static_cast<unsigned char>((rnd[8] & 0x3F) | 0x80);
    std::stringstream ss;
    ss << std::hex << std::setfill('0');
    for (unsigned char b : rnd)
        ss << std::setw(2) << static_cast<int>(b);
    std::string hex = ss.str();
    if (hex.size() > 6)
        hex.resize(6);
    return "guest-" + u + "-" + hex;
}

void StopCoreForSession(const std::string& sessionId) {
    std::lock_guard lock(g_etMutex);
    auto it = g_sessions.find(sessionId);
    if (it == g_sessions.end())
        return;
    stopCoreImpl(it->second);
}

void StopCore() {
    std::lock_guard lock(g_etMutex);
    auto it = g_sessions.find(kHostSession);
    if (it == g_sessions.end())
        return;
    stopCoreImpl(it->second);
}

bool IsCoreRunningForSession(const std::string& sessionId) {
    std::lock_guard lock(g_etMutex);
    auto it = g_sessions.find(sessionId);
    if (it == g_sessions.end())
        return false;
    return isCoreRunningImpl(it->second);
}

bool IsCoreRunning() {
    std::lock_guard lock(g_etMutex);
    auto it = g_sessions.find(kHostSession);
    if (it == g_sessions.end())
        return false;
    return isCoreRunningImpl(it->second);
}

bool HasAnyRunningSession() {
    std::lock_guard lock(g_etMutex);
    for (auto& kv : g_sessions) {
        if (isCoreRunningImpl(kv.second))
            return true;
    }
    return false;
}

#if defined(_WIN32)
/** Appends available pipe data to accum (does not clear accum). */
static bool Win32AppendFromPipe(HANDLE r, std::string& accum, DWORD overallMs) {
    auto start = std::chrono::steady_clock::now();
    char buf[4096];
    for (;;) {
        DWORD avail = 0;
        if (!PeekNamedPipe(r, nullptr, 0, nullptr, &avail, nullptr))
            break;
        if (avail > 0) {
            DWORD n = 0;
            if (!ReadFile(r, buf, sizeof(buf), &n, nullptr) || n == 0)
                break;
            accum.append(buf, buf + n);
        } else {
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - start)
                               .count();
            if (elapsed >= static_cast<long long>(overallMs))
                break;
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
    }
    return true;
}
#endif

std::optional<nlohmann::json> FetchPeerListJsonForSession(const std::string& sessionId) {
    fs::path cli = CliExecutable();
    if (!fs::exists(cli))
        return std::nullopt;

    std::string portal;
    {
        std::lock_guard lock(g_etMutex);
        auto it = g_sessions.find(sessionId);
        if (it == g_sessions.end())
            return std::nullopt;
        portal = it->second.rpcPortal.empty() ? std::string(kDefaultRpcPortal) : it->second.rpcPortal;
    }

#if defined(_WIN32)
    SECURITY_ATTRIBUTES sa {};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    HANDLE rOut = nullptr, wOut = nullptr;
    if (!CreatePipe(&rOut, &wOut, &sa, 0))
        return std::nullopt;
    SetHandleInformation(rOut, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si {};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = wOut;
    si.hStdError = wOut;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

    std::string args = Win32QuoteArg(cli.string()) + " -p " + Win32QuoteArg(portal) + " -o json peer";
    PROCESS_INFORMATION pi {};
    std::vector<char> cmdbuf(args.begin(), args.end());
    cmdbuf.push_back('\0');

    fs::path cwd = GetBP();
    std::string cwdStr = cwd.string();
    if (!CreateProcessA(nullptr, cmdbuf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, cwdStr.c_str(), &si, &pi)) {
        CloseHandle(wOut);
        CloseHandle(rOut);
        return std::nullopt;
    }
    CloseHandle(wOut);

    std::string out;
    for (int i = 0; i < 80; ++i) {
        DWORD w = WaitForSingleObject(pi.hProcess, 100);
        Win32AppendFromPipe(rOut, out, 50);
        if (w != WAIT_TIMEOUT)
            break;
    }
    Win32AppendFromPipe(rOut, out, 200);
    CloseHandle(rOut);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    try {
        return nlohmann::json::parse(out);
    } catch (...) {
        return std::nullopt;
    }
#else
    int pipefd[2];
    if (pipe(pipefd) != 0)
        return std::nullopt;
    pid_t pid = fork();
    if (pid == 0) {
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[1]);
        fs::path cwd = GetBP();
        if (chdir(cwd.c_str()) != 0)
            _exit(126);
        std::string c = cli.string();
        execl(c.c_str(), "easytier-cli", "-p", portal.c_str(), "-o", "json", "peer", nullptr);
        _exit(127);
    }
    close(pipefd[1]);
    std::string out;
    char buf[4096];
    pollfd pfd { pipefd[0], POLLIN, 0 };
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
    while (std::chrono::steady_clock::now() < deadline) {
        int pr = poll(&pfd, 1, 200);
        if (pr > 0 && (pfd.revents & POLLIN)) {
            ssize_t n = read(pipefd[0], buf, sizeof(buf));
            if (n > 0)
                out.append(buf, static_cast<size_t>(n));
            else if (n == 0)
                break;
        }
        int st = 0;
        if (waitpid(pid, &st, WNOHANG) == pid)
            break;
    }
    close(pipefd[0]);
    int st = 0;
    waitpid(pid, &st, 0);
    try {
        return nlohmann::json::parse(out);
    } catch (...) {
        return std::nullopt;
    }
#endif
}

std::optional<nlohmann::json> FetchPeerListJson() {
    return FetchPeerListJsonForSession(kHostSession);
}

std::optional<nlohmann::json> FetchConnectorListJsonForSession(const std::string& sessionId) {
    fs::path cli = CliExecutable();
    if (!fs::exists(cli))
        return std::nullopt;

    std::string portal;
    {
        std::lock_guard lock(g_etMutex);
        auto it = g_sessions.find(sessionId);
        if (it == g_sessions.end())
            return std::nullopt;
        portal = it->second.rpcPortal.empty() ? std::string(kDefaultRpcPortal) : it->second.rpcPortal;
    }

#if defined(_WIN32)
    SECURITY_ATTRIBUTES sa {};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    HANDLE rOut = nullptr, wOut = nullptr;
    if (!CreatePipe(&rOut, &wOut, &sa, 0))
        return std::nullopt;
    SetHandleInformation(rOut, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si {};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = wOut;
    si.hStdError = wOut;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

    std::string args = Win32QuoteArg(cli.string()) + " -p " + Win32QuoteArg(portal) + " -o json connector list";
    PROCESS_INFORMATION pi {};
    std::vector<char> cmdbuf(args.begin(), args.end());
    cmdbuf.push_back('\0');

    fs::path cwd = GetBP();
    std::string cwdStr = cwd.string();
    if (!CreateProcessA(nullptr, cmdbuf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, cwdStr.c_str(), &si, &pi)) {
        CloseHandle(wOut);
        CloseHandle(rOut);
        return std::nullopt;
    }
    CloseHandle(wOut);

    std::string out;
    for (int i = 0; i < 80; ++i) {
        DWORD w = WaitForSingleObject(pi.hProcess, 100);
        Win32AppendFromPipe(rOut, out, 50);
        if (w != WAIT_TIMEOUT)
            break;
    }
    Win32AppendFromPipe(rOut, out, 200);
    CloseHandle(rOut);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    try {
        return nlohmann::json::parse(out);
    } catch (...) {
        return std::nullopt;
    }
#else
    int pipefd[2];
    if (pipe(pipefd) != 0)
        return std::nullopt;
    pid_t pid = fork();
    if (pid == 0) {
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[1]);
        fs::path cwd = GetBP();
        if (chdir(cwd.c_str()) != 0)
            _exit(126);
        std::string c = cli.string();
        execl(c.c_str(), "easytier-cli", "-p", portal.c_str(), "-o", "json", "connector", "list", nullptr);
        _exit(127);
    }
    close(pipefd[1]);
    std::string out;
    char buf[4096];
    pollfd pfd { pipefd[0], POLLIN, 0 };
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
    while (std::chrono::steady_clock::now() < deadline) {
        int pr = poll(&pfd, 1, 200);
        if (pr > 0 && (pfd.revents & POLLIN)) {
            ssize_t n = read(pipefd[0], buf, sizeof(buf));
            if (n > 0)
                out.append(buf, static_cast<size_t>(n));
            else if (n == 0)
                break;
        }
        int st = 0;
        if (waitpid(pid, &st, WNOHANG) == pid)
            break;
    }
    close(pipefd[0]);
    int st = 0;
    waitpid(pid, &st, 0);
    try {
        return nlohmann::json::parse(out);
    } catch (...) {
        return std::nullopt;
    }
#endif
}

std::optional<nlohmann::json> FetchNodeInfoJsonForSession(const std::string& sessionId) {
    fs::path cli = CliExecutable();
    if (!fs::exists(cli))
        return std::nullopt;

    std::string portal;
    {
        std::lock_guard lock(g_etMutex);
        auto it = g_sessions.find(sessionId);
        if (it == g_sessions.end())
            return std::nullopt;
        portal = it->second.rpcPortal.empty() ? std::string(kDefaultRpcPortal) : it->second.rpcPortal;
    }

#if defined(_WIN32)
    SECURITY_ATTRIBUTES sa {};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    HANDLE rOut = nullptr, wOut = nullptr;
    if (!CreatePipe(&rOut, &wOut, &sa, 0))
        return std::nullopt;
    SetHandleInformation(rOut, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si {};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = wOut;
    si.hStdError = wOut;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

    std::string args = Win32QuoteArg(cli.string()) + " -p " + Win32QuoteArg(portal) + " -o json node";
    PROCESS_INFORMATION pi {};
    std::vector<char> cmdbuf(args.begin(), args.end());
    cmdbuf.push_back('\0');

    fs::path cwd = GetBP();
    std::string cwdStr = cwd.string();
    if (!CreateProcessA(nullptr, cmdbuf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, cwdStr.c_str(), &si, &pi)) {
        CloseHandle(wOut);
        CloseHandle(rOut);
        return std::nullopt;
    }
    CloseHandle(wOut);

    std::string out;
    for (int i = 0; i < 80; ++i) {
        DWORD w = WaitForSingleObject(pi.hProcess, 100);
        Win32AppendFromPipe(rOut, out, 50);
        if (w != WAIT_TIMEOUT)
            break;
    }
    Win32AppendFromPipe(rOut, out, 200);
    CloseHandle(rOut);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    try {
        return nlohmann::json::parse(out);
    } catch (...) {
        return std::nullopt;
    }
#else
    int pipefd[2];
    if (pipe(pipefd) != 0)
        return std::nullopt;
    pid_t pid = fork();
    if (pid == 0) {
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[1]);
        fs::path cwd = GetBP();
        if (chdir(cwd.c_str()) != 0)
            _exit(126);
        std::string c = cli.string();
        execl(c.c_str(), "easytier-cli", "-p", portal.c_str(), "-o", "json", "node", nullptr);
        _exit(127);
    }
    close(pipefd[1]);
    std::string out;
    char buf[4096];
    pollfd pfd { pipefd[0], POLLIN, 0 };
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
    while (std::chrono::steady_clock::now() < deadline) {
        int pr = poll(&pfd, 1, 200);
        if (pr > 0 && (pfd.revents & POLLIN)) {
            ssize_t n = read(pipefd[0], buf, sizeof(buf));
            if (n > 0)
                out.append(buf, static_cast<size_t>(n));
            else if (n == 0)
                break;
        }
        int st = 0;
        if (waitpid(pid, &st, WNOHANG) == pid)
            break;
    }
    close(pipefd[0]);
    int st = 0;
    waitpid(pid, &st, 0);
    try {
        return nlohmann::json::parse(out);
    } catch (...) {
        return std::nullopt;
    }
#endif
}

bool HasConflictingHostPeer(const nlohmann::json& peerArray, const std::string& ourHostname) {
    if (!peerArray.is_array())
        return false;
    for (const auto& row : peerArray) {
        if (!row.is_object() || !row.contains("hostname"))
            continue;
        const auto& hn = row["hostname"];
        if (!hn.is_string())
            continue;
        std::string h = hn.get<std::string>();
        if (h.size() >= 5 && h.compare(0, 5, "host-") == 0 && h != ourHostname)
            return true;
    }
    return false;
}

std::string StartCoreForSession(const std::string& sessionId, const std::string& networkName,
    const std::string& networkSecret, const std::string& hostname, const CoreLaunchOptions& optIn) {
    CoreLaunchOptions opt = optIn;
    if (opt.localBeamPort < 1 || opt.localBeamPort > 65535)
        opt.localBeamPort = 30814;
    if (opt.remoteVirtualListenPort < 1 || opt.remoteVirtualListenPort > 65535)
        opt.remoteVirtualListenPort = 30814;

    std::lock_guard lock(g_etMutex);
    EtSession& sess = GetSessionUnlocked(sessionId);
    if (opt.rpcPortal.empty())
        opt.rpcPortal = sess.rpcPortal.empty() ? std::string(kDefaultRpcPortal) : sess.rpcPortal;
    stopCoreImpl(sess);
    sess.rpcPortal = opt.rpcPortal;

    fs::path exe = CoreExecutable();
    if (!fs::exists(exe))
        return "easytier-core not found next to BeamMP-Launcher (copy easytier-core.exe and easytier-cli.exe to launcher folder)";

    fs::path cwd = GetBP();
    std::string wdArg = cwd.string();

    // Collect bare boolean flags
    std::vector<std::string> boolFlags;
    if (opt.dhcp) boolFlags.push_back("--dhcp");
    if (opt.latencyFirst) boolFlags.push_back("--latency-first");
    if (opt.useSmoltcp) boolFlags.push_back("--use-smoltcp");
    if (opt.disableIpv6) boolFlags.push_back("--disable-ipv6");
    if (opt.enableKcpProxy) boolFlags.push_back("--enable-kcp-proxy");
    if (opt.disableKcpInput) boolFlags.push_back("--disable-kcp-input");
    if (opt.enableQuicProxy) boolFlags.push_back("--enable-quic-proxy");
    if (opt.disableQuicInput) boolFlags.push_back("--disable-quic-input");
    if (opt.disableP2p) boolFlags.push_back("--disable-p2p");
    if (opt.bindDevice) boolFlags.push_back("--bind-device=true");
    if (opt.noTun) boolFlags.push_back("--no-tun");
    if (opt.enableExitNode) boolFlags.push_back("--enable-exit-node");
    if (opt.relayAllPeerRpc) boolFlags.push_back("--relay-all-peer-rpc");
    if (opt.multiThread) boolFlags.push_back("--multi-thread");
    if (opt.proxyForwardBySystem) boolFlags.push_back("--proxy-forward-by-system");
    if (opt.disableEncryption) boolFlags.push_back("--disable-encryption");
    if (opt.disableUdpHolePunching) boolFlags.push_back("--disable-udp-hole-punching");
    if (opt.disableSymHolePunching) boolFlags.push_back("--disable-sym-hole-punching");
    if (opt.acceptDns) boolFlags.push_back("--accept-dns");
    if (opt.privateMode) boolFlags.push_back("--private-mode");
    const auto peerList = ParsePeerList(opt.peersCsv);
    if (!peerList.empty())
        debug("EasyTierHost[" + sessionId + "] peers: " + JoinForLog(peerList));
    else if (!opt.peersCsv.empty())
        warn("EasyTierHost[" + sessionId + "] peers configured but none parsed: " + opt.peersCsv);

#if defined(_WIN32)
    std::string cmdLine = Win32QuoteArg(exe.string()) + " " + Win32CmdMergedFlag("network-name", networkName) + " "
        + Win32CmdMergedFlag("network-secret", networkSecret) + " " + Win32CmdMergedFlag("hostname", hostname) + " "
        + Win32CmdMergedFlag("rpc-portal", opt.rpcPortal);
    for (const auto& peer : peerList)
        cmdLine += " " + Win32CmdMergedFlag("peers", peer);
    for (const auto& f : boolFlags)
        cmdLine += " " + Win32QuoteArg(f);

    STARTUPINFOA si {};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi {};
    std::vector<char> buf(cmdLine.begin(), cmdLine.end());
    buf.push_back('\0');
    if (!CreateProcessA(nullptr, buf.data(), nullptr, nullptr, FALSE, CREATE_NEW_PROCESS_GROUP, nullptr, wdArg.c_str(), &si, &pi)) {
        return "CreateProcess easytier-core failed";
    }
    CloseHandle(pi.hThread);
    pi.hThread = nullptr;
    RoomHost::AssignChildToKillOnCloseJobIfPossible(pi.hProcess);
    sess.proc = pi;
    sess.hasProc = true;
    return {};
#else
    sess.pid = fork();
    if (sess.pid == 0) {
#if defined(__linux__)
        (void)prctl(PR_SET_PDEATHSIG, SIGTERM);
#endif
        if (chdir(wdArg.c_str()) != 0)
            _exit(126);
        std::string exes = exe.string();
        std::vector<std::string> sargs;
        sargs.push_back(std::move(exes));
        sargs.push_back("--network-name=" + networkName);
        sargs.push_back("--network-secret=" + networkSecret);
        sargs.push_back("--hostname=" + hostname);
        sargs.push_back(std::string("--rpc-portal=") + opt.rpcPortal);
        for (const auto& peer : peerList)
            sargs.push_back(std::string("--peers=") + peer);
        for (const auto& f : boolFlags)
            sargs.push_back(f);
        std::vector<char*> argv;
        argv.reserve(sargs.size() + 1);
        for (auto& s : sargs)
            argv.push_back(s.data());
        argv.push_back(nullptr);
        execv(sargs[0].c_str(), argv.data());
        _exit(127);
    }
    if (sess.pid < 0)
        return "fork easytier-core failed";
    return {};
#endif
}

std::string StartCore(const std::string& networkName, const std::string& networkSecret, const std::string& hostname,
    const CoreLaunchOptions& optIn) {
    return StartCoreForSession(kHostSession, networkName, networkSecret, hostname, optIn);
}

} // namespace EasyTierHost
