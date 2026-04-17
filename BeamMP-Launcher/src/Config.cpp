/*
 Copyright (C) 2024 BeamMP Ltd., BeamMP team and contributors.
 Licensed under AGPL-3.0 (or later), see <https://www.gnu.org/licenses/>.
 SPDX-License-Identifier: AGPL-3.0-or-later
*/

#include "Logger.h"
#include "Network/network.hpp"
#include "Options.h"
#include "Startup.h"
#include "Utils.h"
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
namespace fs = std::filesystem;

std::string Branch;
std::filesystem::path CachingDirectory = GetBP() / "Resources";
bool deleteDuplicateMods = false;

void ParseConfig(const nlohmann::json& d) {
    if (d["Port"].is_number()) {
        options.port = d["Port"].get<int>();
    }
    // Default -1
    // Release 1
    // EA 2
    // Dev 3
    // Custom 3
    if (d["Build"].is_string()) {
        Branch = d["Build"].get<std::string>();
        for (char& c : Branch)
            c = char(tolower(c));
    }
    if (d.contains("CachingDirectory") && d["CachingDirectory"].is_string()) {
        fs::path p = fs::path(d["CachingDirectory"].get<std::string>()).lexically_normal();
        if (p.is_absolute())
            CachingDirectory = std::move(p);
        else
            CachingDirectory = GetBP() / p;
        info("Mod caching directory: " + CachingDirectory.string());
    }

    if (d.contains("Dev") && d["Dev"].is_boolean()) {
        bool dev = d["Dev"].get<bool>();
        options.verbose = dev;
        options.no_download = dev;
        options.no_launch = dev;
        options.no_update = dev;
    }

    if (d.contains(("DeleteDuplicateMods")) && d["DeleteDuplicateMods"].is_boolean()) {
        deleteDuplicateMods = d["DeleteDuplicateMods"].get<bool>();
    }

    if (d.contains("Offline") && d["Offline"].is_boolean()) {
        options.offline_mode = d["Offline"].get<bool>();
        if (options.offline_mode) {
            options.no_update = true;
            options.no_download = true;
        }
    }
    if (d.contains("OfflineUsername") && d["OfflineUsername"].is_string()) {
        options.offline_username = d["OfflineUsername"].get<std::string>();
    }

}

void ConfigInit() {
    // Use the launcher's install directory, not the process CWD (shortcuts often set CWD wrong).
    const fs::path cfgPath = GetBP() / "Launcher.cfg";
    if (fs::exists(cfgPath)) {
        std::ifstream cfg(cfgPath);
        if (cfg.is_open()) {
            auto Size = fs::file_size(cfgPath);
            std::string Buffer(Size, 0);
            cfg.read(&Buffer[0], Size);
            cfg.close();
            nlohmann::json d = nlohmann::json::parse(Buffer, nullptr, false);
            if (d.is_discarded()) {
                fatal("Config failed to parse make sure it's valid JSON!");
            }
            ParseConfig(d);
        } else
            fatal("Failed to open Launcher.cfg!");
    } else {
        std::ofstream cfg(cfgPath);
        if (cfg.is_open()) {
            static const char* defaultJson = R"({
    "Port": 4444,
    "Build": "Default",
    "CachingDirectory": "Resources",
    "Offline": true,
    "OfflineUsername": ""
})";
            cfg << defaultJson;
            cfg.close();
            nlohmann::json d = nlohmann::json::parse(defaultJson, nullptr, false);
            if (!d.is_discarded())
                ParseConfig(d);
        } else {
            fatal("Failed to write config on disk!");
        }
    }
}
