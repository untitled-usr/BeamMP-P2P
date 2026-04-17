/*
 Copyright (C) 2024 BeamMP Ltd., BeamMP team and contributors.
 Licensed under AGPL-3.0 (or later), see <https://www.gnu.org/licenses/>.
 SPDX-License-Identifier: AGPL-3.0-or-later
*/


#include "Http.h"
#include "Logger.h"
#include "Options.h"
#include "Startup.h"
#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>

namespace fs = std::filesystem;
std::string PublicKey;
std::string PrivateKey;
extern bool LoginAuth;
extern std::string Username;
extern std::string UserRole;
extern int UserID;

static void TrimAsciiWs(std::string& s) {
    auto notspace = [](unsigned char c) { return !std::isspace(c); };
    s.erase(s.begin(), std::find_if(s.begin(), s.end(), notspace));
    s.erase(std::find_if(s.rbegin(), s.rend(), notspace).base(), s.end());
}

// Allowed: [A-Za-z0-9_], max 32. Empty in / all-invalid out => "" (never substitute a default name).
static std::string SanitizeOfflineUsername(std::string Name) {
    TrimAsciiWs(Name);
    std::string Out;
    for (char Ch : Name) {
        if (Out.size() >= 32)
            break;
        if (std::isalnum(static_cast<unsigned char>(Ch)) || Ch == '_')
            Out += Ch;
    }
    return Out;
}

static fs::path KeyFilePath() {
    return GetBP() / "key";
}

void UpdateKey(const char* newKey) {
    if (newKey && std::isalnum(newKey[0])) {
        PrivateKey = newKey;
        std::ofstream Key(KeyFilePath());
        if (Key.is_open()) {
            Key << newKey;
            Key.close();
        } else
            fatal("Cannot write to disk!");
    } else if (fs::exists(KeyFilePath())) {
        std::error_code ec;
        fs::remove(KeyFilePath(), ec);
    }
}

/// "username":"value","password":"value"
/// "Guest":"Name"
/// "pk":"private_key"

std::string GetFail(const std::string& R) {
    std::string DRet = R"({"success":false,"message":)";
    DRet += "\"" + R + "\"}";
    error(R);
    return DRet;
}

std::string Login(const std::string& fields) {
    if (fields == "LO") {
        Username.clear();
        UserRole.clear();
        UserID = -1;
        LoginAuth = false;
        PublicKey.clear();
        PrivateKey.clear();
        UpdateKey(nullptr);
        info("Logged out: session token and keys cleared.");
        return R"({"logout":true,"Auth":0,"success":false,"message":"Logged out"})";
    }
    if (options.offline_mode) {
        std::string Name = options.offline_username;
        if (!fields.empty() && fields.front() == '{') {
            nlohmann::json GuestTry = nlohmann::json::parse(fields, nullptr, false);
            if (!GuestTry.is_discarded() && GuestTry.contains("Guest") && GuestTry["Guest"].is_string())
                Name = GuestTry["Guest"].get<std::string>();
        }
        Name = SanitizeOfflineUsername(Name);
        if (Name.empty()) {
            return GetFail("Username cannot be empty. Use letters, digits, and underscore only (1-32 characters).");
        }
        PublicKey = "offline:" + Name;
        Username = Name;
        UserRole = "USER";
        UserID = -1;
        LoginAuth = true;
        UpdateKey(nullptr);
        info("Offline login as \"" + Name + "\" (token " + PublicKey + ")");
        nlohmann::json Ok = {
            { "success", true },
            { "message", "Offline mode" },
            { "username", Name },
            { "role", "USER" },
        };
        return Ok.dump();
    }
    info("Attempting to authenticate...");
    try {
        std::string Buffer = HTTP::Post("https://auth.beammp.com/userlogin", fields);

        if (Buffer.empty()) {
            return GetFail("Failed to communicate with the auth system!");
        }

        nlohmann::json d = nlohmann::json::parse(Buffer, nullptr, false);

        if (Buffer.at(0) != '{' || d.is_discarded()) {
            error(Buffer);
            return GetFail("Invalid answer from authentication servers, please try again later!");
        }
        if (d.contains("success") && d["success"].get<bool>()) {
            LoginAuth = true;
            if (d.contains("username")) {
                Username = d["username"].get<std::string>();
            }
            if (d.contains("role")) {
                UserRole = d["role"].get<std::string>();
            }
            if (d.contains("id")) {
                UserID = d["id"].get<int>();
            }
            if (d.contains("private_key")) {
                UpdateKey(d["private_key"].get<std::string>().c_str());
            }
            if (d.contains("public_key")) {
                PublicKey = d["public_key"].get<std::string>();
            }
            info("Authentication successful!");
        } else
            info("Authentication failed!");
        if (d.contains("message")) {
            d.erase("private_key");
            d.erase("public_key");
            debug("Authentication result: " + d["message"].get<std::string>());
            return d.dump();
        }
        return GetFail("Invalid message parsing!");
    } catch (const std::exception& e) {
        return GetFail(e.what());
    }
}

void CheckLocalKey() {
    if (options.offline_mode) {
        UpdateKey(nullptr);
        std::string Name = SanitizeOfflineUsername(options.offline_username);
        if (!Name.empty()) {
            PublicKey = "offline:" + Name;
            Username = Name;
            UserRole = "USER";
            UserID = -1;
            LoginAuth = true;
            info("Offline mode: using identity \"" + PublicKey + "\" from launcher config/args");
            return;
        }
        if (!LoginAuth) {
            PublicKey.clear();
            Username.clear();
            UserRole.clear();
            UserID = -1;
            info("Offline mode: enter a username in BeamMP Multiplayer login, or set OfflineUsername in Launcher.cfg / --offline-name");
        }
        return;
    }
    const fs::path keyPath = KeyFilePath();
    if (fs::exists(keyPath) && fs::file_size(keyPath) < 100) {
        std::ifstream Key(keyPath);
        if (Key.is_open()) {
            auto Size = fs::file_size(keyPath);
            std::string Buffer(Size, 0);
            Key.read(&Buffer[0], Size);
            Key.close();

            for (char& c : Buffer) {
                if (!std::isalnum(c) && c != '-') {
                    UpdateKey(nullptr);
                    return;
                }
            }

            Buffer = HTTP::Post("https://auth.beammp.com/userlogin", R"({"pk":")" + Buffer + "\"}");

            nlohmann::json d = nlohmann::json::parse(Buffer, nullptr, false);

            if (Buffer.empty() || Buffer.at(0) != '{' || d.is_discarded()) {
                error(Buffer);
                info("Invalid answer from authentication servers.");
                UpdateKey(nullptr);
            }
            if (d["success"].get<bool>()) {
                LoginAuth = true;
                UpdateKey(d["private_key"].get<std::string>().c_str());
                PublicKey = d["public_key"].get<std::string>();
                if (d.contains("username")) {
                    Username = d["username"].get<std::string>();
                }
                if (d.contains("role")) {
                    UserRole = d["role"].get<std::string>();
                }
                if (d.contains("id")) {
                    UserID = d["id"].get<int>();
                }
            } else {
                info("Auto-Authentication unsuccessful please re-login!");
                UpdateKey(nullptr);
            }
        } else {
            warn("Could not open saved key!");
            UpdateKey(nullptr);
        }
    } else
        UpdateKey(nullptr);
}
