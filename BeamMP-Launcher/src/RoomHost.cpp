/*
 Copyright (C) 2024 BeamMP Ltd., BeamMP team and contributors.
 Licensed under AGPL-3.0 (or later), see <https://www.gnu.org/licenses/>.
 SPDX-License-Identifier: AGPL-3.0-or-later
*/

#include "RoomHost.h"
#include "EasyTierHost.h"
#include "Logger.h"
#include "Startup.h"

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <mutex>
#include <optional>
#include <random>
#include <sstream>
#include <string_view>
#include <thread>
#include <unordered_set>

extern std::string Username;

#if !defined(_WIN32)
using SOCKET = int;
#ifndef INVALID_SOCKET
constexpr int INVALID_SOCKET = -1;
#endif
static int closesocket(int s) { return close(s); }
#endif

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#else
#include <csignal>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/prctl.h>
#endif
#endif

namespace fs = std::filesystem;

static std::string EscTomlString(std::string s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        if (c == '\\' || c == '"')
            out += '\\';
        out += c;
    }
    return out;
}

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

static std::string NormalizePeersCsv(std::string_view raw) {
    std::vector<std::string> items;
    std::unordered_set<std::string> seen;
    std::string token;
    token.reserve(raw.size());

    auto flush = [&]() {
        std::string t = TrimAsciiWs(token);
        token.clear();
        if (t.empty())
            return;
        if (seen.insert(t).second)
            items.push_back(std::move(t));
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

    std::string out;
    for (size_t i = 0; i < items.size(); ++i) {
        if (i)
            out += ",";
        out += items[i];
    }
    return out;
}

static std::string NormalizeRoomKind(std::string kindRaw) {
    std::string k = TrimAsciiWs(std::move(kindRaw));
    std::transform(k.begin(), k.end(), k.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    if (k == "guestroom" || k == "guest_room" || k == "guest-room")
        return "guestRoom";
    if (k == "savedserver" || k == "saved_server" || k == "saved-server")
        return "savedServer";
    return "hostRoom";
}

static nlohmann::json PeersCsvToJsonArray(std::string_view raw) {
    nlohmann::json arr = nlohmann::json::array();
    const std::string norm = NormalizePeersCsv(raw);
    if (norm.empty())
        return arr;
    size_t pos = 0;
    while (pos < norm.size()) {
        size_t next = norm.find(',', pos);
        std::string item = (next == std::string::npos) ? norm.substr(pos) : norm.substr(pos, next - pos);
        item = TrimAsciiWs(std::move(item));
        if (!item.empty()) {
            if (item.find("://") == std::string::npos)
                item = "tcp://" + item;
            arr.push_back(item);
        }
        if (next == std::string::npos)
            break;
        pos = next + 1;
    }
    return arr;
}

// BeamMP-Server ArgsParser only accepts --name=value (one token), not --name value.
#if defined(_WIN32)
/** One CreateProcess argument: quoted "--flag=value" with embedded " escaped per Win32 rules. */
static std::string Win32CmdArgMergedFlag(std::string_view flagName, const std::string& value) {
    std::string inner;
    inner.append("--");
    inner.append(flagName);
    inner.push_back('=');
    inner.append(value);
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
#endif


extern void CoreSend(std::string data);

namespace RoomHost {

std::mutex g_mutex;
static std::atomic<long long> g_suppressQuitUntilTick { 0 };

#if defined(_WIN32)
PROCESS_INFORMATION g_serverProc {};
bool g_hasProc = false;
/** Kept open for process lifetime; JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE ends BeamMP-Server when launcher exits. */
static HANDLE g_winKillOnCloseJob = nullptr;

static void Win32EnsureKillOnCloseJob() {
    if (g_winKillOnCloseJob)
        return;
    g_winKillOnCloseJob = CreateJobObjectW(nullptr, nullptr);
    if (!g_winKillOnCloseJob)
        return;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli {};
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(g_winKillOnCloseJob, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
        CloseHandle(g_winKillOnCloseJob);
        g_winKillOnCloseJob = nullptr;
        return;
    }
    if (!AssignProcessToJobObject(g_winKillOnCloseJob, GetCurrentProcess())) {
        CloseHandle(g_winKillOnCloseJob);
        g_winKillOnCloseJob = nullptr;
    }
}
#else
pid_t g_serverPid = -1;
#endif
std::string g_activeRoomId;
std::string g_activeGuestRoomId;

fs::path RoomsRoot() {
    return GetBP() / "rooms";
}

std::string NewRoomId() {
    std::random_device rd;
    std::mt19937_64 gen(rd());
    std::uniform_int_distribution<uint64_t> dist;
    std::stringstream ss;
    ss << std::hex << dist(gen) << dist(gen);
    return ss.str();
}

void Reply(const nlohmann::json& j) {
    CoreSend("H" + j.dump());
}

void ReplyError(std::string_view msg) {
    Reply(nlohmann::json { { "ok", false }, { "error", std::string(msg) } });
}

void ReplyStoppedWithError(std::string_view msg) {
    Reply(nlohmann::json {
        { "ok", false },
        { "error", std::string(msg) },
        { "running", false },
        { "activeRoomId", "" }
    });
}

fs::path RoomJsonPath(const std::string& id) {
    return RoomsRoot() / (id + ".json");
}

fs::path RoomRunDir(const std::string& id) {
    return RoomsRoot() / id / "run";
}

fs::path ServerExecutable() {
    fs::path bp = GetBP();
#if defined(_WIN32)
    auto exe = bp / "BeamMP-Server.exe";
    if (fs::exists(exe))
        return exe;
#else
    auto exe = bp / "BeamMP-Server";
    if (fs::exists(exe))
        return exe;
#endif
    return {};
}

void StopServerUnlocked() {
    debug("RoomHost::StopServerUnlocked() enter");
    EasyTierHost::StopCoreForSession("host");
    debug("RoomHost::StopServerUnlocked() EasyTier stopped, now stopping BeamMP-Server");
#if defined(_WIN32)
    if (g_hasProc) {
        debug("RoomHost::StopServerUnlocked() terminating server process");
        TerminateProcess(g_serverProc.hProcess, 1);
        CloseHandle(g_serverProc.hProcess);
        g_serverProc.hProcess = nullptr;
        g_serverProc.hThread = nullptr;
        g_hasProc = false;
        debug("RoomHost::StopServerUnlocked() server terminated");
    }
#else
    if (g_serverPid > 0) {
        kill(g_serverPid, SIGTERM);
        int st = 0;
        waitpid(g_serverPid, &st, 0);
        g_serverPid = -1;
    }
#endif
    g_activeRoomId.clear();
}

bool IsServerRunningUnlocked() {
#if defined(_WIN32)
    if (!g_hasProc)
        return false;
    DWORD code = STILL_ACTIVE;
    if (GetExitCodeProcess(g_serverProc.hProcess, &code) && code == STILL_ACTIVE)
        return true;
    CloseHandle(g_serverProc.hProcess);
    CloseHandle(g_serverProc.hThread);
    ZeroMemory(&g_serverProc, sizeof(g_serverProc));
    g_hasProc = false;
    g_activeRoomId.clear();
    return false;
#else
    if (g_serverPid <= 0)
        return false;
    int st = 0;
    pid_t r = waitpid(g_serverPid, &st, WNOHANG);
    if (r == 0)
        return true;
    g_serverPid = -1;
    g_activeRoomId.clear();
    return false;
#endif
}

std::optional<nlohmann::json> LoadRoomFile(const std::string& id) {
    auto p = RoomJsonPath(id);
    if (!fs::exists(p))
        return std::nullopt;
    try {
        std::ifstream in(p);
        nlohmann::json j;
        in >> j;
        return j;
    } catch (...) {
        return std::nullopt;
    }
}

bool WriteRoomFile(const nlohmann::json& room) {
    if (!room.contains("id") || !room["id"].is_string())
        return false;
    fs::create_directories(RoomsRoot());
    auto p = RoomJsonPath(room["id"].get<std::string>());
    std::ofstream out(p);
    out << room.dump(2);
    return out.good();
}

void WriteServerConfigToml(const fs::path& runDir, const nlohmann::json& room) {
    fs::create_directories(runDir / "Resources" / "Client");

    auto str = [](const nlohmann::json& j, const char* k, const std::string& def) -> std::string {
        if (j.contains(k) && j[k].is_string())
            return j[k].get<std::string>();
        return def;
    };
    auto integer = [](const nlohmann::json& j, const char* k, int def) -> int {
        if (j.contains(k) && j[k].is_number_integer())
            return j[k].get<int>();
        return def;
    };
    auto boolean = [](const nlohmann::json& j, const char* k, bool def) -> bool {
        if (j.contains(k) && j[k].is_boolean())
            return j[k].get<bool>();
        return def;
    };

    const std::string name = EscTomlString(str(room, "name", str(room, "displayName", "BeamMP LAN Room")));
    const int port = integer(room, "port", 30814);
    const int maxPl = integer(room, "maxPlayers", 8);
    const int maxCars = integer(room, "maxCars", 1);
    const std::string map = EscTomlString(str(room, "map", "/levels/gridmap_v2/info.json"));
    const std::string desc = EscTomlString(str(room, "description", "LAN"));
    const std::string tags = EscTomlString(str(room, "tags", "Freeroam"));
    const bool logChat = boolean(room, "logChat", true);
    const bool allowGuests = boolean(room, "allowGuests", true);
    const bool infoPkt = boolean(room, "informationPacket", true);
    const bool debug = boolean(room, "debug", false);
    const std::string bindIp = EscTomlString(str(room, "bindIp", "0.0.0.0"));

    std::ostringstream toml;
    toml << "[General]\n";
    toml << "AuthKey = \"\"\n";
    toml << "Debug = " << (debug ? "true" : "false") << "\n";
    toml << "Private = true\n";
    toml << "InformationPacket = " << (infoPkt ? "true" : "false") << "\n";
    toml << "IP = \"" << bindIp << "\"\n";
    toml << "Port = " << port << "\n";
    toml << "MaxCars = " << maxCars << "\n";
    toml << "MaxPlayers = " << maxPl << "\n";
    toml << "Map = \"" << map << "\"\n";
    toml << "Name = \"" << name << "\"\n";
    toml << "Description = \"" << desc << "\"\n";
    toml << "Tags = \"" << tags << "\"\n";
    toml << "ResourceFolder = \"Resources\"\n";
    toml << "LogChat = " << (logChat ? "true" : "false") << "\n";
    toml << "AllowGuests = " << (allowGuests ? "true" : "false") << "\n";
    toml << "OfflineMode = true\n";
    toml << "\n[Misc]\n";
    toml << "ImScaredOfUpdates = true\n";
    toml << "SendErrors = false\n";
    toml << "SendErrorsShowMessage = false\n";

    std::ofstream cfg(runDir / "ServerConfig.toml");
    cfg << toml.str();
}

static bool IsExcludedModZip(std::string_view fname) {
    std::string lower;
    lower.resize(fname.size());
    std::transform(fname.begin(), fname.end(), lower.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    return lower.find("beammp") != std::string::npos || lower.find("multiplayerbeammp") != std::string::npos;
}

static void SyncClientZips(const fs::path& clientDir, const nlohmann::json& room) {
    fs::create_directories(clientDir);
    for (const auto& e : fs::directory_iterator(clientDir)) {
        if (e.is_regular_file() && e.path().extension() == ".zip")
            fs::remove(e.path());
    }

    std::vector<fs::path> scanRoots;
    if (room.contains("modsScanPath") && room["modsScanPath"].is_string()) {
        scanRoots.push_back(fs::path(room["modsScanPath"].get<std::string>()));
    } else {
#if defined(_WIN32)
#pragma warning(suppress: 4996)
        if (const char* up = std::getenv("USERPROFILE"); up && *up) {
            auto m = fs::path(up) / "Documents" / "BeamNG.drive" / "mods";
            if (fs::exists(m))
                scanRoots.push_back(m);
        }
#else
        if (const char* h = std::getenv("HOME"); h && *h) {
            auto m = fs::path(h) / "Documents" / "BeamNG.drive" / "mods";
            if (fs::exists(m))
                scanRoots.push_back(m);
        }
#endif
    }

    auto tryLinkOrCopy = [](const fs::path& from, const fs::path& to) -> bool {
#if defined(_WIN32)
        if (CreateHardLinkW(to.wstring().c_str(), from.wstring().c_str(), nullptr))
            return true;
#else
        std::error_code ec;
        fs::create_hard_link(from, to, ec);
        if (!ec)
            return true;
#endif
        std::error_code ec2;
        fs::copy_file(from, to, fs::copy_options::overwrite_existing, ec2);
        return !ec2;
    };

    for (const auto& root : scanRoots) {
        if (!fs::exists(root))
            continue;
        try {
            for (const auto& e : fs::recursive_directory_iterator(root, fs::directory_options::skip_permission_denied)) {
                if (!e.is_regular_file() || e.path().extension() != ".zip")
                    continue;
                const auto fname = e.path().filename().string();
                if (IsExcludedModZip(fname))
                    continue;
                const auto dest = clientDir / fname;
                if (fs::exists(dest))
                    continue;
                if (!tryLinkOrCopy(e.path(), dest))
                    warn("RoomHost: could not link/copy mod zip " + e.path().string());
            }
        } catch (const std::exception& ex) {
            warn(std::string("RoomHost: mod scan error: ") + ex.what());
        }
    }
}

nlohmann::json ListRoomsJson() {
    nlohmann::json arr = nlohmann::json::array();
    if (!fs::exists(RoomsRoot()))
        return arr;
    for (const auto& e : fs::directory_iterator(RoomsRoot())) {
        if (!e.is_regular_file() || e.path().extension() != ".json")
            continue;
        try {
            std::ifstream in(e.path());
            nlohmann::json j;
            in >> j;
            const std::string fallbackId = e.path().stem().string();
            if (!j.contains("id") || !j["id"].is_string() || j["id"].get<std::string>().empty())
                j["id"] = fallbackId;
            j["kind"] = NormalizeRoomKind(j.value("kind", std::string("hostRoom")));
            arr.push_back(std::move(j));
        } catch (const std::exception& ex) {
            warn("RoomHost: failed to parse room file " + e.path().string() + ": " + ex.what());
        } catch (...) {
            warn("RoomHost: failed to parse room file " + e.path().string());
        }
    }
    return arr;
}

void CmdList() {
    std::lock_guard lock(g_mutex);
    nlohmann::json o;
    o["ok"] = true;
    o["rooms"] = ListRoomsJson();
    o["running"] = IsServerRunningUnlocked();
    o["activeRoomId"] = g_activeRoomId;
    o["guestJoinedRoomId"] = g_activeGuestRoomId;
    Reply(o);
}

void CmdStatus() {
    std::lock_guard lock(g_mutex);
    nlohmann::json o;
    o["ok"] = true;
    o["running"] = IsServerRunningUnlocked();
    o["activeRoomId"] = g_activeRoomId;
    if (!g_activeRoomId.empty()) {
        if (auto r = LoadRoomFile(g_activeRoomId))
            o["port"] = (*r).value("port", 30814);
    }
    Reply(o);
}

void CmdSave(const std::string& jsonBody) {
    nlohmann::json room;
    try {
        room = nlohmann::json::parse(jsonBody);
    } catch (...) {
        ReplyError("invalid JSON");
        return;
    }
    if (!room.contains("id") || !room["id"].is_string() || room["id"].get<std::string>().empty())
        room["id"] = NewRoomId();
    const std::string id = room["id"].get<std::string>();
    std::string kind = "hostRoom";
    if (room.contains("kind") && room["kind"].is_string() && !room["kind"].get<std::string>().empty())
        kind = room["kind"].get<std::string>();
    if (kind != "hostRoom" && kind != "guestRoom" && kind != "savedServer") {
        ReplyError("invalid config kind");
        return;
    }
    room["kind"] = kind;

    auto trim = [](std::string& s) {
        while (!s.empty() && (s.back() == ' ' || s.back() == '\t'))
            s.pop_back();
        size_t i = 0;
        while (i < s.size() && (s[i] == ' ' || s[i] == '\t'))
            ++i;
        if (i > 0)
            s.erase(0, i);
    };

    if (kind == "savedServer") {
        std::string ip = room.value("serverIp", std::string(""));
        trim(ip);
        if (ip.empty()) {
            ReplyError("Server IP is required");
            return;
        }
        if (ip.size() > 120) {
            ReplyError("Server IP too long");
            return;
        }
        for (char c : ip) {
            const bool ok = (std::isalnum(static_cast<unsigned char>(c)) != 0) || c == '.' || c == ':' || c == '-' || c == '_';
            if (!ok) {
                ReplyError("Server IP contains invalid characters");
                return;
            }
        }
        int port = 30814;
        if (room.contains("port")) {
            if (!room["port"].is_number_integer()) {
                ReplyError("Server port must be an integer");
                return;
            }
            port = room["port"].get<int>();
        }
        if (port < 1 || port > 65535) {
            ReplyError("Server port must be between 1 and 65535");
            return;
        }
        room["serverIp"] = ip;
        room["port"] = port;
        room["displayName"] = room.value("displayName", ip + ":" + std::to_string(port));
        room["name"] = room.value("name", room["displayName"].get<std::string>());
        room["remoteMultiplayerEnabled"] = false;
    }

    if (!room.contains("name") || !room["name"].is_string()) {
        if (room.contains("displayName") && room["displayName"].is_string())
            room["name"] = room["displayName"];
        else
            room["name"] = "LAN Room";
    }
    if (!room.contains("displayName") || !room["displayName"].is_string()) {
        if (room.contains("name") && room["name"].is_string())
            room["displayName"] = room["name"];
        else
            room["displayName"] = "LAN Room";
    }
    if (room.contains("displayName") && room["displayName"].is_string()) {
        std::string dn = room["displayName"].get<std::string>();
        trim(dn);
        room["displayName"] = dn;
    }
    if (room.contains("name") && room["name"].is_string()) {
        std::string n = room["name"].get<std::string>();
        trim(n);
        room["name"] = n;
    }
    if (!room.contains("port"))
        room["port"] = 30814;
    if (!room.contains("map"))
        room["map"] = "/levels/gridmap_v2/info.json";

    if (kind == "guestRoom")
        room["remoteMultiplayerEnabled"] = true;

    const bool remoteOn = kind != "savedServer" && room.contains("remoteMultiplayerEnabled") && room["remoteMultiplayerEnabled"].is_boolean()
        && room["remoteMultiplayerEnabled"].get<bool>();
    if (remoteOn) {
        std::string pw;
        if (room.contains("remoteRoomPassword") && room["remoteRoomPassword"].is_string())
            pw = room["remoteRoomPassword"].get<std::string>();
        trim(pw);
        if (pw.empty()) {
            ReplyError("Remote multiplayer requires a room password");
            return;
        }
        room["remoteRoomPassword"] = pw;
        std::string rpc = (kind == "guestRoom") ? "127.0.0.1:15889" : "127.0.0.1:15888";
        if (room.contains("remoteEasyTierRpcPortal") && room["remoteEasyTierRpcPortal"].is_string()) {
            rpc = room["remoteEasyTierRpcPortal"].get<std::string>();
            trim(rpc);
        }
        if (rpc.empty())
            rpc = (kind == "guestRoom") ? "127.0.0.1:15889" : "127.0.0.1:15888";
        for (char c : rpc) {
            if (c == '\n' || c == '\r' || c == '"' || c == '\t') {
                ReplyError("EasyTier RPC address contains invalid characters");
                return;
            }
        }
        if (rpc.size() > 160) {
            ReplyError("EasyTier RPC address too long");
            return;
        }
        room["remoteEasyTierRpcPortal"] = rpc;

        int rv = 30814;
        if (room.contains("remoteVirtualListenPort")) {
            if (!room["remoteVirtualListenPort"].is_number_integer()) {
                ReplyError("Virtual listen port must be an integer");
                return;
            }
            rv = room["remoteVirtualListenPort"].get<int>();
        }
        if (rv < 1 || rv > 65535) {
            ReplyError("Virtual listen port must be between 1 and 65535");
            return;
        }
        room["remoteVirtualListenPort"] = rv;

        std::string peers;
        if (room.contains("remoteEasyTierPeers") && room["remoteEasyTierPeers"].is_string())
            peers = room["remoteEasyTierPeers"].get<std::string>();
        if (peers.find('"') != std::string::npos) {
            ReplyError("Peers list contains invalid characters");
            return;
        }
        peers = NormalizePeersCsv(peers);
        if (peers.size() > 4096) {
            ReplyError("Peers list too long");
            return;
        }
        room["remoteEasyTierPeers"] = peers;
    }

    std::lock_guard lock(g_mutex);
    if (kind == "hostRoom" && IsServerRunningUnlocked() && g_activeRoomId == id) {
        ReplyError("stop the running room before editing");
        return;
    }
    if (kind == "guestRoom" && !g_activeGuestRoomId.empty() && g_activeGuestRoomId == id) {
        ReplyError("leave the joined room before editing");
        return;
    }
    if (!WriteRoomFile(room)) {
        ReplyError("failed to write room file");
        return;
    }
    Reply(nlohmann::json { { "ok", true }, { "room", room }, { "saved", true } });
}

void CmdGet(const std::string& id) {
    std::lock_guard lock(g_mutex);
    auto o = LoadRoomFile(id);
    if (!o) {
        ReplyError("room not found");
        return;
    }
    Reply(nlohmann::json { { "ok", true }, { "room", *o } });
}

void CmdDelete(const std::string& id) {
    std::lock_guard lock(g_mutex);
    if (g_activeRoomId == id && IsServerRunningUnlocked()) {
        ReplyError("stop the room before delete");
        return;
    }
    if (g_activeGuestRoomId == id) {
        ReplyError("leave the room before delete");
        return;
    }
    auto jp = RoomJsonPath(id);
    auto rd = RoomsRoot() / id;
    std::error_code ec;
    fs::remove(jp, ec);
    fs::remove_all(rd, ec);
    nlohmann::json o;
    o["ok"] = true;
    o["rooms"] = ListRoomsJson();
    o["running"] = IsServerRunningUnlocked();
    o["activeRoomId"] = g_activeRoomId;
    o["guestJoinedRoomId"] = g_activeGuestRoomId;
    Reply(o);
}

void CmdStop() {
    debug("RoomHost::CmdStop() enter");
    std::lock_guard lock(g_mutex);
    StopServerUnlocked();
    debug("RoomHost::CmdStop() replying");
    Reply(nlohmann::json { { "ok", true }, { "running", false }, { "activeRoomId", "" } });
    debug("RoomHost::CmdStop() done");
}

/** Runs without holding RoomHost::g_mutex (may take several seconds). */
static std::string StartEasyTierSessionIfEnabled(const nlohmann::json& room, std::string* outHostname) {
    if (outHostname)
        outHostname->clear();
    if (!room.value("remoteMultiplayerEnabled", false))
        return {};
    std::string pwd = TrimAsciiWs(room.value("remoteRoomPassword", std::string("")));
    if (pwd.empty())
        return "Remote multiplayer requires a room password";

    std::string displayName = TrimAsciiWs(room.value("displayName", room.value("name", std::string("LAN Room"))));
    if (displayName.empty())
        displayName = "LAN Room";
    const std::string netName = EasyTierHost::BuildNetworkName(displayName);
    const std::string netSecret = EasyTierHost::BuildNetworkSecret(pwd);
    const std::string hostname = EasyTierHost::BuildHostHostname(Username);
    if (outHostname)
        *outHostname = hostname;
    const int beamPort = room.value("port", 30814);
    std::string rpcPortal = TrimAsciiWs(room.value("remoteEasyTierRpcPortal", std::string("127.0.0.1:15888")));
    if (rpcPortal.empty())
        rpcPortal = "127.0.0.1:15888";
    const int virtPort = room.value("remoteVirtualListenPort", 30814);
    const std::string peersCsv = NormalizePeersCsv(room.value("remoteEasyTierPeers", std::string("")));

    EasyTierHost::CoreLaunchOptions etOpt;
    etOpt.localBeamPort = beamPort;
    etOpt.remoteVirtualListenPort = virtPort;
    etOpt.rpcPortal = rpcPortal;
    etOpt.peersCsv = peersCsv;
    etOpt.dhcp = room.value("etDhcp", true);
    etOpt.latencyFirst = room.value("etLatencyFirst", false);
    etOpt.useSmoltcp = room.value("etUseSmoltcp", false);
    etOpt.disableIpv6 = room.value("etDisableIpv6", false);
    etOpt.enableKcpProxy = room.value("etEnableKcpProxy", false);
    etOpt.disableKcpInput = room.value("etDisableKcpInput", false);
    etOpt.enableQuicProxy = room.value("etEnableQuicProxy", false);
    etOpt.disableQuicInput = room.value("etDisableQuicInput", false);
    etOpt.disableP2p = room.value("etDisableP2p", false);
    etOpt.bindDevice = room.value("etBindDevice", true);
    etOpt.noTun = room.value("etNoTun", false);
    etOpt.enableExitNode = room.value("etEnableExitNode", false);
    etOpt.relayAllPeerRpc = room.value("etRelayAllPeerRpc", false);
    etOpt.multiThread = room.value("etMultiThread", true);
    etOpt.proxyForwardBySystem = room.value("etProxyForwardBySystem", false);
    etOpt.disableEncryption = room.value("etDisableEncryption", false);
    etOpt.disableUdpHolePunching = room.value("etDisableUdpHolePunching", false);
    etOpt.disableSymHolePunching = room.value("etDisableSymHolePunching", false);
    etOpt.acceptDns = room.value("etAcceptDns", false);
    etOpt.privateMode = room.value("etPrivateMode", false);

    std::string startErr = EasyTierHost::StartCoreForSession("host", netName, netSecret, hostname, etOpt);
    if (!startErr.empty())
        return startErr;

    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    if (!EasyTierHost::IsCoreRunningForSession("host")) {
        EasyTierHost::StopCoreForSession("host");
        return "easytier-core exited unexpectedly; check wintun.dll / Packet.dll next to launcher and run as admin if required";
    }
    return {};
}

enum class HostConflictCheckResult {
    NoConflict,
    Conflict,
    Timeout
};

static HostConflictCheckResult HasConflictingHostPeerWithin3Seconds(const std::string& ourHostname) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    bool gotDefiniteList = false;
    while (std::chrono::steady_clock::now() < deadline) {
        auto jopt = EasyTierHost::FetchPeerListJson();
        if (jopt && jopt->is_array()) {
            gotDefiniteList = true;
            if (EasyTierHost::HasConflictingHostPeer(*jopt, ourHostname))
                return HostConflictCheckResult::Conflict;
            return HostConflictCheckResult::NoConflict;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
    }
    return gotDefiniteList ? HostConflictCheckResult::NoConflict : HostConflictCheckResult::Timeout;
}

static std::string ExtractFirstHostPeerIp(const nlohmann::json& peerArray) {
    if (!peerArray.is_array())
        return {};
    auto readIp = [](const nlohmann::json& row) -> std::string {
        static const char* keys[] = { "virtual_ipv4", "ipv4", "virtual_ip", "ip" };
        for (const char* k : keys) {
            if (row.contains(k) && row[k].is_string()) {
                auto v = row[k].get<std::string>();
                if (!v.empty())
                    return v;
            }
        }
        return {};
    };
    for (const auto& row : peerArray) {
        if (!row.is_object() || !row.contains("hostname") || !row["hostname"].is_string())
            continue;
        const std::string hn = row["hostname"].get<std::string>();
        if (hn.size() >= 5 && hn.compare(0, 5, "host-") == 0) {
            auto ip = readIp(row);
            if (!ip.empty())
                return ip;
        }
    }
    return {};
}

static bool RecvAllRaw(SOCKET s, char* dst, int len) {
    int got = 0;
    while (got < len) {
        int n = recv(s, dst + got, len - got, 0);
        if (n <= 0)
            return false;
        got += n;
    }
    return true;
}

static std::optional<nlohmann::json> QueryBeamMpServerInfoJson(const std::string& ip, int port) {
    if (ip.empty() || port < 1 || port > 65535)
        return std::nullopt;
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET)
        return std::nullopt;
    sockaddr_in addr {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<u_short>(port));
    if (inet_pton(AF_INET, ip.c_str(), &addr.sin_addr) != 1) {
        closesocket(s);
        return std::nullopt;
    }
    if (connect(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        closesocket(s);
        return std::nullopt;
    }
    char code = 'I';
    if (send(s, &code, 1, 0) != 1) {
        closesocket(s);
        return std::nullopt;
    }
    int32_t hdr = 0;
    if (!RecvAllRaw(s, reinterpret_cast<char*>(&hdr), static_cast<int>(sizeof(hdr)))) {
        closesocket(s);
        return std::nullopt;
    }
    if (hdr <= 0 || hdr > 256 * 1024) {
        closesocket(s);
        return std::nullopt;
    }
    std::string body;
    body.resize(static_cast<size_t>(hdr));
    if (!RecvAllRaw(s, body.data(), hdr)) {
        closesocket(s);
        return std::nullopt;
    }
    closesocket(s);
    try {
        auto j = nlohmann::json::parse(body);
        if (j.is_object())
            return j;
        return nlohmann::json { { "raw", body } };
    } catch (...) {
        return nlohmann::json { { "raw", body } };
    }
}

enum class GuestHostCheckResult {
    HostFound,
    HostOffline,
    Timeout
};

static GuestHostCheckResult WaitHostOnlineAndGetIp(const std::string& sessionId, std::string* outIp) {
    if (outIp)
        outIp->clear();
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    bool gotDefiniteList = false;
    while (std::chrono::steady_clock::now() < deadline) {
        auto jopt = EasyTierHost::FetchPeerListJsonForSession(sessionId);
        if (jopt && jopt->is_array()) {
            gotDefiniteList = true;
            std::string ip = ExtractFirstHostPeerIp(*jopt);
            if (!ip.empty()) {
                if (outIp)
                    *outIp = ip;
                return GuestHostCheckResult::HostFound;
            }
            return GuestHostCheckResult::HostOffline;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
    }
    return gotDefiniteList ? GuestHostCheckResult::HostOffline : GuestHostCheckResult::Timeout;
}

static std::string StartGuestEasyTierFromRoom(const nlohmann::json& room) {
    const std::string pwd = TrimAsciiWs(room.value("remoteRoomPassword", std::string("")));
    if (pwd.empty())
        return "Remote multiplayer requires a room password";
    std::string displayName = TrimAsciiWs(room.value("displayName", room.value("name", std::string("Remote Room"))));
    if (displayName.empty())
        displayName = "Remote Room";
    const std::string netName = EasyTierHost::BuildNetworkName(displayName);
    const std::string netSecret = EasyTierHost::BuildNetworkSecret(pwd);
    const std::string hostname = EasyTierHost::BuildGuestHostname(Username);

    EasyTierHost::CoreLaunchOptions etOpt;
    etOpt.localBeamPort = room.value("port", 30814);
    etOpt.remoteVirtualListenPort = room.value("remoteVirtualListenPort", 30814);
    etOpt.rpcPortal = TrimAsciiWs(room.value("remoteEasyTierRpcPortal", std::string("127.0.0.1:15889")));
    if (etOpt.rpcPortal.empty())
        etOpt.rpcPortal = "127.0.0.1:15889";
    etOpt.peersCsv = NormalizePeersCsv(room.value("remoteEasyTierPeers", std::string("")));
    etOpt.dhcp = room.value("etDhcp", true);
    etOpt.latencyFirst = room.value("etLatencyFirst", false);
    etOpt.useSmoltcp = room.value("etUseSmoltcp", false);
    etOpt.disableIpv6 = room.value("etDisableIpv6", false);
    etOpt.enableKcpProxy = room.value("etEnableKcpProxy", false);
    etOpt.disableKcpInput = room.value("etDisableKcpInput", false);
    etOpt.enableQuicProxy = room.value("etEnableQuicProxy", false);
    etOpt.disableQuicInput = room.value("etDisableQuicInput", false);
    etOpt.disableP2p = room.value("etDisableP2p", false);
    etOpt.bindDevice = room.value("etBindDevice", true);
    etOpt.noTun = room.value("etNoTun", false);
    etOpt.enableExitNode = room.value("etEnableExitNode", false);
    etOpt.relayAllPeerRpc = room.value("etRelayAllPeerRpc", false);
    etOpt.multiThread = room.value("etMultiThread", true);
    etOpt.proxyForwardBySystem = room.value("etProxyForwardBySystem", false);
    etOpt.disableEncryption = room.value("etDisableEncryption", false);
    etOpt.disableUdpHolePunching = room.value("etDisableUdpHolePunching", false);
    etOpt.disableSymHolePunching = room.value("etDisableSymHolePunching", false);
    etOpt.acceptDns = room.value("etAcceptDns", false);
    etOpt.privateMode = room.value("etPrivateMode", false);

    std::string startErr = EasyTierHost::StartCoreForSession("guest", netName, netSecret, hostname, etOpt);
    if (!startErr.empty())
        return startErr;
    std::this_thread::sleep_for(std::chrono::milliseconds(450));
    if (!EasyTierHost::IsCoreRunningForSession("guest")) {
        EasyTierHost::StopCoreForSession("guest");
        return "easytier-core exited unexpectedly; check wintun.dll / Packet.dll next to launcher and run as admin if required";
    }
    return {};
}

void CmdGuestStop() {
    EasyTierHost::StopCoreForSession("guest");
    g_activeGuestRoomId.clear();
    Reply(nlohmann::json { { "ok", true }, { "guestStopped", true }, { "guestJoinedRoomId", "" } });
}

void CmdGuestJoin(const std::string& id) {
    nlohmann::json room;
    {
        std::lock_guard lock(g_mutex);
        if (IsServerRunningUnlocked()) {
            ReplyError("please stop room service first");
            return;
        }
        if (!g_activeGuestRoomId.empty() && g_activeGuestRoomId != id) {
            ReplyError("please leave current room first");
            return;
        }
        if (g_activeGuestRoomId == id && EasyTierHost::IsCoreRunningForSession("guest")) {
            Reply(nlohmann::json { { "ok", true }, { "guestJoined", true }, { "guestJoinedRoomId", id } });
            return;
        }
        auto roomOpt = LoadRoomFile(id);
        if (!roomOpt) {
            ReplyError("room not found");
            return;
        }
        room = *roomOpt;
        if (room.value("kind", std::string("hostRoom")) != "guestRoom") {
            ReplyError("not a guest room config");
            return;
        }
    }
    std::string err = StartGuestEasyTierFromRoom(room);
    if (!err.empty()) {
        g_activeGuestRoomId.clear();
        std::lock_guard lock(g_mutex);
        if (IsServerRunningUnlocked())
            ReplyError("please stop room service first");
        else
            ReplyError(err);
        return;
    }
    g_activeGuestRoomId = id;
    Reply(nlohmann::json { { "ok", true }, { "guestJoined", true }, { "guestJoinedRoomId", id } });
}

void CmdGuestEnter(const std::string& id) {
    nlohmann::json room;
    {
        std::lock_guard lock(g_mutex);
        auto roomOpt = LoadRoomFile(id);
        if (!roomOpt) {
            ReplyError("room not found");
            return;
        }
        room = *roomOpt;
        if (room.value("kind", std::string("hostRoom")) != "guestRoom") {
            ReplyError("not a guest room config");
            return;
        }
    }
    if (!EasyTierHost::IsCoreRunningForSession("guest")) {
        ReplyError("please join room first");
        return;
    }
    std::string hostIp;
    const auto chk = WaitHostOnlineAndGetIp("guest", &hostIp);
    if (chk == GuestHostCheckResult::Timeout) {
        ReplyError("peer check timeout");
        return;
    }
    if (chk != GuestHostCheckResult::HostFound) {
        ReplyError("host is offline");
        return;
    }
    const int virtPort = room.value("remoteVirtualListenPort", 30814);
    if (auto sinfo = QueryBeamMpServerInfoJson(hostIp, virtPort)) {
        try {
            int cur = std::stoi(sinfo->value("players", std::string("0")));
            int max = std::stoi(sinfo->value("maxplayers", std::string("0")));
            if (max > 0 && cur >= max) {
                ReplyError("server is full (" + std::to_string(cur) + "/" + std::to_string(max) + ")");
                return;
            }
        } catch (...) {}
    }
    Reply(nlohmann::json {
        { "ok", true },
        { "guestEnter", {
            { "ip", hostIp },
            { "port", virtPort },
            { "name", room.value("displayName", std::string("Remote Room")) }
        } }
    });
}

void CmdEtInfo(const std::string& scope) {
    nlohmann::json out;
    out["ok"] = true;
    out["etInfo"] = nlohmann::json::object();
    if (scope == "guest") {
        if (g_activeGuestRoomId.empty() || !EasyTierHost::IsCoreRunningForSession("guest")) {
            ReplyError("guest room not joined");
            return;
        }
        out["etInfo"]["scope"] = "guest";
        out["etInfo"]["roomId"] = g_activeGuestRoomId;
        std::optional<nlohmann::json> peers;
        if (auto p = EasyTierHost::FetchPeerListJsonForSession("guest")) {
            peers = *p;
            out["etInfo"]["peers"] = *p;
        }
        if (auto n = EasyTierHost::FetchNodeInfoJsonForSession("guest"))
            out["etInfo"]["node"] = *n;
        if (auto c = EasyTierHost::FetchConnectorListJsonForSession("guest"))
            out["etInfo"]["connectors"] = *c;
        auto roomOpt = LoadRoomFile(g_activeGuestRoomId);
        if (roomOpt)
            out["etInfo"]["configuredPeers"] = PeersCsvToJsonArray(roomOpt->value("remoteEasyTierPeers", std::string("")));
        if (roomOpt && peers && peers->is_array()) {
            const std::string hostIp = ExtractFirstHostPeerIp(*peers);
            const int hostPort = roomOpt->value("remoteVirtualListenPort", 30814);
            if (!hostIp.empty()) {
                if (auto sinfo = QueryBeamMpServerInfoJson(hostIp, hostPort)) {
                    out["etInfo"]["serverInfo"] = *sinfo;
                    out["etInfo"]["serverHostIp"] = hostIp;
                    out["etInfo"]["serverHostPort"] = hostPort;
                }
            }
        }
        Reply(out);
        return;
    }
    if (scope == "host") {
        if (g_activeRoomId.empty() || !IsServerRunningUnlocked()) {
            ReplyError("host room not running");
            return;
        }
        auto roomOpt = LoadRoomFile(g_activeRoomId);
        if (!roomOpt || !roomOpt->value("remoteMultiplayerEnabled", false)) {
            ReplyError("remote multiplayer not enabled");
            return;
        }
        out["etInfo"]["scope"] = "host";
        out["etInfo"]["roomId"] = g_activeRoomId;
        if (auto p = EasyTierHost::FetchPeerListJsonForSession("host"))
            out["etInfo"]["peers"] = *p;
        if (auto n = EasyTierHost::FetchNodeInfoJsonForSession("host"))
            out["etInfo"]["node"] = *n;
        if (auto c = EasyTierHost::FetchConnectorListJsonForSession("host"))
            out["etInfo"]["connectors"] = *c;
        out["etInfo"]["configuredPeers"] = PeersCsvToJsonArray(roomOpt->value("remoteEasyTierPeers", std::string("")));
        Reply(out);
        return;
    }
    ReplyError("unknown et info scope");
}

void CmdStart(const std::string& id) {
    SuppressLauncherQuitFor(std::chrono::seconds(6));
    nlohmann::json room;
    fs::path exe;
    {
        std::lock_guard lock(g_mutex);
        exe = ServerExecutable();
        if (exe.empty() || !fs::exists(exe)) {
            ReplyError("BeamMP-Server not found next to BeamMP-Launcher");
            return;
        }
        auto roomOpt = LoadRoomFile(id);
        if (!roomOpt) {
            ReplyError("room not found");
            return;
        }
        room = *roomOpt;
        const std::string kind = room.value("kind", std::string("hostRoom"));
        if (kind != "hostRoom") {
            ReplyError("only host room can be started");
            return;
        }
        if (!g_activeGuestRoomId.empty() || EasyTierHost::IsCoreRunningForSession("guest")) {
            ReplyError("please leave room first");
            return;
        }

        if (IsServerRunningUnlocked() && g_activeRoomId != id) {
            ReplyError("please stop room service first");
            return;
        }
        if (IsServerRunningUnlocked() && g_activeRoomId == id) {
            Reply(nlohmann::json { { "ok", true }, { "running", true }, { "activeRoomId", id }, { "message", "already running" } });
            return;
        }
    }

    std::string etHostname;
    std::string etErr = StartEasyTierSessionIfEnabled(room, &etHostname);
    if (!etErr.empty()) {
        ReplyError(etErr);
        return;
    }

    std::lock_guard lock(g_mutex);
    if (!g_activeGuestRoomId.empty() || EasyTierHost::IsCoreRunningForSession("guest")) {
        EasyTierHost::StopCoreForSession("host");
        ReplyError("please leave room first");
        return;
    }
    if (IsServerRunningUnlocked()) {
        if (g_activeRoomId != id) {
            EasyTierHost::StopCoreForSession("host");
            ReplyError("please stop room service first");
            return;
        }
    }

    const nlohmann::json& roomRef = room;
    fs::path runDir = RoomRunDir(id);
    fs::create_directories(runDir);
    WriteServerConfigToml(runDir, roomRef);
    SyncClientZips(runDir / "Resources" / "Client", roomRef);

    fs::path cfgPath = runDir / "ServerConfig.toml";
    std::string cfgArg = cfgPath.string();
    std::string wdArg = runDir.string();

#if defined(_WIN32)
    Win32EnsureKillOnCloseJob();
    std::string cmdLine = "\"" + exe.string() + "\" " + Win32CmdArgMergedFlag("config", cfgArg) + " "
        + Win32CmdArgMergedFlag("working-directory", wdArg);
    STARTUPINFOA si {};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi {};
    std::vector<char> buf(cmdLine.begin(), cmdLine.end());
    buf.push_back('\0');
    if (!CreateProcessA(nullptr, buf.data(), nullptr, nullptr, FALSE, CREATE_NEW_PROCESS_GROUP, nullptr,
            wdArg.c_str(), &si, &pi)) {
        EasyTierHost::StopCoreForSession("host");
        ReplyError("CreateProcess failed");
        return;
    }
    if (g_winKillOnCloseJob && !AssignProcessToJobObject(g_winKillOnCloseJob, pi.hProcess))
        warn("RoomHost: AssignProcessToJobObject failed; server may outlive launcher");
    CloseHandle(pi.hThread);
    pi.hThread = nullptr;
    g_serverProc = pi;
    g_hasProc = true;
#else
    g_serverPid = fork();
    if (g_serverPid == 0) {
#if defined(__linux__)
        (void)prctl(PR_SET_PDEATHSIG, SIGTERM);
#endif
        std::string exes = exe.string();
        if (chdir(wdArg.c_str()) != 0)
            _exit(126);
        std::string argConfig = std::string("--config=") + cfgArg;
        std::string argWd = std::string("--working-directory=") + wdArg;
        execl(exes.c_str(), "BeamMP-Server", argConfig.c_str(), argWd.c_str(), nullptr);
        _exit(127);
    }
    if (g_serverPid < 0) {
        EasyTierHost::StopCoreForSession("host");
        ReplyError("fork failed");
        return;
    }
#endif
    g_activeRoomId = id;

    if (!etHostname.empty()) {
        if (!EasyTierHost::IsCoreRunningForSession("host")) {
            StopServerUnlocked();
            SuppressLauncherQuitFor(std::chrono::milliseconds(0));
            ReplyStoppedWithError("easytier-core exited unexpectedly; check wintun.dll / Packet.dll next to launcher and run as admin if required");
            return;
        }
        const auto hostCheck = HasConflictingHostPeerWithin3Seconds(etHostname);
        if (hostCheck == HostConflictCheckResult::Timeout) {
            StopServerUnlocked();
            SuppressLauncherQuitFor(std::chrono::milliseconds(0));
            ReplyStoppedWithError("peer check timeout");
            return;
        }
        if (hostCheck == HostConflictCheckResult::Conflict) {
            StopServerUnlocked();
            SuppressLauncherQuitFor(std::chrono::milliseconds(0));
            ReplyStoppedWithError("Room name or password conflicts with another user");
            return;
        }
    }

    SuppressLauncherQuitFor(std::chrono::milliseconds(0));
    Reply(nlohmann::json { { "ok", true }, { "running", true }, { "activeRoomId", id }, { "port", roomRef.value("port", 30814) } });
}

fs::path RoomsDirectory() {
    return RoomsRoot();
}

void HandlePacket(const std::string& afterHColon) {
    if (afterHColon == "LIST") {
        CmdList();
        return;
    }
    if (afterHColon == "STATUS") {
        CmdStatus();
        return;
    }
    if (afterHColon == "STOP") {
        CmdStop();
        return;
    }
    if (afterHColon == "GUEST_STOP") {
        CmdGuestStop();
        return;
    }
    if (afterHColon.rfind("SAVE:", 0) == 0) {
        CmdSave(afterHColon.substr(5));
        return;
    }
    if (afterHColon.rfind("GET:", 0) == 0) {
        CmdGet(afterHColon.substr(4));
        return;
    }
    if (afterHColon.rfind("DELETE:", 0) == 0) {
        CmdDelete(afterHColon.substr(7));
        return;
    }
    if (afterHColon.rfind("START:", 0) == 0) {
        CmdStart(afterHColon.substr(6));
        return;
    }
    if (afterHColon.rfind("GUEST_JOIN:", 0) == 0) {
        CmdGuestJoin(afterHColon.substr(11));
        return;
    }
    if (afterHColon.rfind("GUEST_ENTER:", 0) == 0) {
        CmdGuestEnter(afterHColon.substr(12));
        return;
    }
    if (afterHColon == "ETINFO:GUEST") {
        CmdEtInfo("guest");
        return;
    }
    if (afterHColon == "ETINFO:HOST") {
        CmdEtInfo("host");
        return;
    }
    warn("RoomHost: ignoring unknown room command: " + (afterHColon.size() > 40 ? afterHColon.substr(0, 40) + "..." : afterHColon));
}

void StopRoomServerIfRunning() {
    std::lock_guard lock(g_mutex);
    StopServerUnlocked();
    EasyTierHost::StopCoreForSession("guest");
    g_activeGuestRoomId.clear();
}

void SuppressLauncherQuitFor(std::chrono::milliseconds duration) {
    const auto now = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto until = (std::chrono::steady_clock::now() + duration).time_since_epoch().count();
    if (until > now)
        g_suppressQuitUntilTick.store(static_cast<long long>(until), std::memory_order_relaxed);
    else
        g_suppressQuitUntilTick.store(0, std::memory_order_relaxed);
}

bool ShouldSuppressLauncherQuitNow() {
    const auto now = std::chrono::steady_clock::now().time_since_epoch().count();
    return now < g_suppressQuitUntilTick.load(std::memory_order_relaxed);
}

#if defined(_WIN32)
void AssignChildToKillOnCloseJobIfPossible(void* win32ProcessHandle) {
    auto* hProcess = static_cast<HANDLE>(win32ProcessHandle);
    if (!hProcess)
        return;
    Win32EnsureKillOnCloseJob();
    if (g_winKillOnCloseJob && !AssignProcessToJobObject(g_winKillOnCloseJob, hProcess))
        warn("RoomHost: AssignProcessToJobObject (easytier) failed; process may outlive launcher");
}
#endif

} // namespace RoomHost
