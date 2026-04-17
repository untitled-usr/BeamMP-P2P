/*
 Copyright (C) 2024 BeamMP Ltd., BeamMP team and contributors.
 Licensed under AGPL-3.0 (or later), see <https://www.gnu.org/licenses/>.
 SPDX-License-Identifier: AGPL-3.0-or-later
*/

#pragma once

#include <chrono>
#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>

/// LAN room hosting: persist room JSON, generate ServerConfig.toml, sync Client zips, spawn BeamMP-Server child.
namespace RoomHost {

std::filesystem::path RoomsDirectory();

/// Handle game packet body after leading "H:" (e.g. "LIST", "SAVE:{...}"). Sends CoreSend("H" + json).
void HandlePacket(const std::string& afterHColon);

/// Stop LAN BeamMP-Server child if running (idempotent). Called from atexit / console shutdown.
void StopRoomServerIfRunning();

/// Temporarily suppress launcher self-exit on 'QG' packets (used during room start/conflict checks).
void SuppressLauncherQuitFor(std::chrono::milliseconds duration);
bool ShouldSuppressLauncherQuitNow();

#if defined(_WIN32)
/// Assign a child process handle to the same Job Object as the launcher (kill on launcher exit).
void AssignChildToKillOnCloseJobIfPossible(void* win32ProcessHandle);
#endif

} // namespace RoomHost
