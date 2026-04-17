/*
 Copyright (C) 2024 BeamMP Ltd., BeamMP team and contributors.
 Licensed under AGPL-3.0 (or later), see <https://www.gnu.org/licenses/>.
 SPDX-License-Identifier: AGPL-3.0-or-later
*/

#pragma once

#include <filesystem>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

namespace EasyTierHost {

std::filesystem::path CoreExecutable();
std::filesystem::path CliExecutable();

/** SHA-256 hex (64 chars). */
std::string Sha256Hex(std::string_view data);

/** beammp-p2p-room-<first 16 hex chars of sha256(displayName)> */
std::string BuildNetworkName(const std::string& displayName);

/** First 32 hex chars of sha256(utf8 password). */
std::string BuildNetworkSecret(const std::string& password);

/** Safe segment for hostname; non-alnum -> underscore, capped length. */
std::string SanitizeUsernameSegment(const std::string& username);

/** host-<user>-<6 hex> */
std::string BuildHostHostname(const std::string& launcherUsername);
/** guest-<user>-<uuid4 first 6 hex chars> */
std::string BuildGuestHostname(const std::string& launcherUsername);

struct CoreLaunchOptions {
    int localBeamPort { 30814 };
    /** Virtual-network TCP listen port (maps to local BeamMP-Server port). */
    int remoteVirtualListenPort { 30814 };
    /** easytier-core --rpc-portal and easytier-cli -p (e.g. 127.0.0.1:15888). */
    std::string rpcPortal { "127.0.0.1:15888" };
    /** Optional comma-separated --peers URLs (EasyTier public nodes / manual peers). */
    std::string peersCsv;

    bool dhcp { true };
    bool latencyFirst { false };
    bool useSmoltcp { false };
    bool disableIpv6 { false };
    bool enableKcpProxy { false };
    bool disableKcpInput { false };
    bool enableQuicProxy { false };
    bool disableQuicInput { false };
    bool disableP2p { false };
    bool bindDevice { true };
    bool noTun { false };
    bool enableExitNode { false };
    bool relayAllPeerRpc { false };
    bool multiThread { true };
    bool proxyForwardBySystem { false };
    bool disableEncryption { false };
    bool disableUdpHolePunching { false };
    bool disableSymHolePunching { false };
    bool acceptDns { false };
    bool privateMode { false };
};

/** Start easytier-core with network/auth/rpc options. Returns empty string on success, else error message. */
std::string StartCore(const std::string& networkName, const std::string& networkSecret, const std::string& hostname,
    const CoreLaunchOptions& opt = {});
std::string StartCoreForSession(const std::string& sessionId, const std::string& networkName,
    const std::string& networkSecret, const std::string& hostname, const CoreLaunchOptions& opt = {});

/** Terminate easytier-core if we started it (no-op if not running). */
void StopCore();
void StopCoreForSession(const std::string& sessionId);

bool IsCoreRunning();
bool IsCoreRunningForSession(const std::string& sessionId);
bool HasAnyRunningSession();

/**
 * Run easytier-cli peer -o json against the RPC portal last used by StartCore (default 127.0.0.1:15888).
 * Returns nullopt on spawn/timeout/parse failure.
 */
std::optional<nlohmann::json> FetchPeerListJson();
std::optional<nlohmann::json> FetchPeerListJsonForSession(const std::string& sessionId);
std::optional<nlohmann::json> FetchConnectorListJsonForSession(const std::string& sessionId);
std::optional<nlohmann::json> FetchNodeInfoJsonForSession(const std::string& sessionId);

/**
 * True if another peer hostname starts with "host-" and is not our hostname.
 */
bool HasConflictingHostPeer(const nlohmann::json& peerArray, const std::string& ourHostname);

} // namespace EasyTierHost
