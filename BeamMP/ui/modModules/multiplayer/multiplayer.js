// Copyright (C) 2024 BeamMP Ltd., BeamMP team and contributors.
// Licensed under AGPL-3.0 (or later), see <https://www.gnu.org/licenses/>.
// SPDX-License-Identifier: AGPL-3.0-or-later

var highlightedServer;
var servers = [];
var mdDialog;
var mdDialogVisible = false;
var userData = {
	username: 'Loading...',
	role: 'USER',
	color: '',
	id: -1
};
var beammpMetrics = {
	players: "...", 
	servers: "...",
	beammpGameVer: "...",
	beammpLauncherVer: "..."
}
var serverView = "all";
let repopulateServerList = async function() {

};


import('/ui/lib/ext/purify.min.js')

/**
 * Room pages: $translate.instant often returns "" before mp_locales are merged; never show blank UI.
 */
function beammpRoomTranslate($translate, key, fb) {
	if (!$translate || typeof $translate.instant !== 'function')
		return (fb && (fb.en || fb.zhHant || fb.zh)) || key;
	var v = $translate.instant(key);
	if (v && String(v).trim() !== '' && v !== key)
		return v;
	var lang = typeof $translate.use === 'function' ? String($translate.use() || '') : '';
	var l = lang.toLowerCase();
	var isZhHant = /zh[-_](tw|hk|mo)|hant/.test(l);
	var isZhHans = /zh[-_](cn|sg)|hans/.test(l) || l === 'zh';
	if (fb) {
		if (isZhHant && fb.zhHant) return fb.zhHant;
		if (isZhHans && fb.zh) return fb.zh;
		if (fb.en) return fb.en;
		if (fb.zhHant) return fb.zhHant;
		if (fb.zh) return fb.zh;
	}
	return v || key;
}

function beammpLocaleText($translate, fb) {
	var lang = '';
	if ($translate && typeof $translate.use === 'function')
		lang = String($translate.use() || '').toLowerCase();
	var isZhHant = /zh[-_](tw|hk|mo)|hant/.test(lang);
	var isZhHans = /zh[-_](cn|sg)|hans/.test(lang) || lang === 'zh';
	if (isZhHant) return fb.zhHant || fb.en || fb.zh || '';
	if (isZhHans) return fb.zh || fb.en || fb.zhHant || '';
	if (fb.en) return fb.en;
	if (fb.zhHant) return fb.zhHant;
	return fb.zh || '';
}

function beammpEtToArray(v) {
	if (Array.isArray(v))
		return v;
	if (!v || typeof v !== 'object')
		return [];
	var out = [];
	angular.forEach(v, function(x) { out.push(x); });
	return out;
}

function beammpPick(obj, keys) {
	if (!obj || typeof obj !== 'object')
		return '';
	for (var i = 0; i < keys.length; i++) {
		var k = keys[i];
		if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '')
			return String(obj[k]);
	}
	return '';
}

function beammpFlattenScalars(obj, prefix, out) {
	if (!obj || typeof obj !== 'object')
		return;
	if (Array.isArray(obj)) {
		for (var i = 0; i < obj.length; i++) {
			beammpFlattenScalars(obj[i], prefix ? (prefix + '.' + i) : String(i), out);
		}
		return;
	}
	angular.forEach(obj, function(v, k) {
		var key = prefix ? (prefix + '.' + k) : String(k);
		if (v === null || v === undefined)
			return;
		if (typeof v === 'object') {
			beammpFlattenScalars(v, key, out);
			return;
		}
		var sv = String(v).trim();
		if (!sv.length)
			return;
		out.push({ key: key.toLowerCase(), value: sv });
	});
}

function beammpDeepPick(obj, patterns) {
	var flat = [];
	beammpFlattenScalars(obj, '', flat);
	for (var i = 0; i < patterns.length; i++) {
		var p = patterns[i];
		for (var j = 0; j < flat.length; j++) {
			var k = flat[j].key;
			var ok = false;
			if (p instanceof RegExp)
				ok = p.test(k);
			else
				ok = k.indexOf(String(p).toLowerCase()) !== -1;
			if (ok)
				return flat[j].value;
		}
	}
	return '';
}

function beammpNatTypeName(n) {
	if (n === undefined || n === null || n === '') return '';
	var v = parseInt(n, 10);
	if (isNaN(v)) {
		var s = String(n).trim();
		return s.length ? s : '';
	}
	var names = {
		0: 'Unknown', 1: 'OpenInternet', 2: 'NoPAT', 3: 'FullCone',
		4: 'Restricted', 5: 'PortRestricted', 6: 'Symmetric',
		7: 'SymUdpFirewall', 8: 'SymmetricEasyInc', 9: 'SymmetricEasyDec'
	};
	return names[v] || ('NatType(' + v + ')');
}

function beammpUint32ToIpv4(n) {
	n = (n || 0) >>> 0;
	if (!n) return '';
	return ((n >>> 24) & 0xFF) + '.' + ((n >>> 16) & 0xFF) + '.' + ((n >>> 8) & 0xFF) + '.' + (n & 0xFF);
}

function beammpIpv6AddrToStr(obj) {
	if (!obj || typeof obj !== 'object') return '';
	var parts = [(obj.part1 || 0) >>> 0, (obj.part2 || 0) >>> 0, (obj.part3 || 0) >>> 0, (obj.part4 || 0) >>> 0];
	if (!parts[0] && !parts[1] && !parts[2] && !parts[3]) return '';
	var groups = [];
	for (var i = 0; i < 4; i++) {
		groups.push(((parts[i] >>> 16) & 0xFFFF).toString(16));
		groups.push((parts[i] & 0xFFFF).toString(16));
	}
	return groups.join(':');
}

function beammpBuildNodeSummary(nodeRaw, peers) {
	var node = nodeRaw && typeof nodeRaw === 'object' ? nodeRaw : {};
	var line1 = [];
	var line2 = [];

	function add(arr, label, value) {
		if (value !== undefined && value !== null && String(value).trim() !== '' && String(value).trim() !== '0.0.0.0')
			arr.push({ label: label, value: String(value) });
	}

	add(line1, 'Virtual IPv4', node.ipv4_addr);
	add(line1, 'Hostname', node.hostname);

	if (node.stun_info && Array.isArray(node.stun_info.public_ip)) {
		for (var i = 0; i < node.stun_info.public_ip.length; i++) {
			add(line1, 'Public IP', node.stun_info.public_ip[i]);
		}
	}

	if (node.ip_list && Array.isArray(node.ip_list.interface_ipv4s)) {
		for (var i = 0; i < node.ip_list.interface_ipv4s.length; i++) {
			var ipObj = node.ip_list.interface_ipv4s[i];
			if (ipObj && typeof ipObj === 'object' && ipObj.addr !== undefined)
				add(line1, 'Local IPv4', beammpUint32ToIpv4(ipObj.addr));
			else if (typeof ipObj === 'string')
				add(line1, 'Local IPv4', ipObj);
		}
	}

	if (node.ip_list && Array.isArray(node.ip_list.interface_ipv6s)) {
		for (var i = 0; i < node.ip_list.interface_ipv6s.length; i++) {
			var v6 = beammpIpv6AddrToStr(node.ip_list.interface_ipv6s[i]);
			if (v6) add(line1, 'Local IPv6', v6);
		}
	}

	var listeners = [];
	var lArr = beammpEtToArray(node.listeners);
	for (var j = 0; j < lArr.length; j++) {
		var lStr = String(lArr[j] || '').trim();
		if (lStr.length && lStr.indexOf('ring') !== 0)
			listeners.push(lStr);
	}
	if (!listeners.length && node.ip_list && Array.isArray(node.ip_list.listeners)) {
		for (var j = 0; j < node.ip_list.listeners.length; j++) {
			var urlObj = node.ip_list.listeners[j];
			var urlStr = '';
			if (urlObj && typeof urlObj === 'object' && urlObj.url)
				urlStr = String(urlObj.url).trim();
			else if (typeof urlObj === 'string')
				urlStr = String(urlObj).trim();
			if (urlStr.length && urlStr.indexOf('ring') !== 0)
				listeners.push(urlStr);
		}
	}
	var protoGroups = {};
	for (var j = 0; j < listeners.length; j++) {
		var proto = beammpProtocolFromUrl(listeners[j]) || 'OTHER';
		if (!protoGroups[proto]) protoGroups[proto] = [];
		protoGroups[proto].push(listeners[j]);
	}
	var protoKeys = Object.keys(protoGroups).sort();
	for (var j = 0; j < protoKeys.length; j++) {
		var urls = protoGroups[protoKeys[j]];
		add(line2, protoKeys[j] + ' Listeners', urls.length <= 2 ? urls.join(' , ') : urls.slice(0, 2).join(' , ') + ' (+' + (urls.length - 2) + ')');
	}

	if (node.stun_info) {
		add(line2, 'UDP NAT Type', beammpNatTypeName(node.stun_info.udp_nat_type));
		add(line2, 'TCP NAT Type', beammpNatTypeName(node.stun_info.tcp_nat_type));
	}

	add(line2, 'Peer ID', node.peer_id);
	add(line2, 'Version', node.version);

	return { line1: line1, line2: line2 };
}

function beammpNormalizeConnectorStatus(s) {
	var v = String(s || '').trim();
	if (!v.length)
		return '';
	var u = v.toUpperCase();
	if (u === '0')
		return 'CONNECTED';
	if (u === '1')
		return 'DISCONNECTED';
	if (u === '2')
		return 'CONNECTING';
	return u;
}

function beammpProtocolFromUrl(url) {
	var m = String(url || '').match(/^([a-z0-9+\-.]+):\/\//i);
	return m && m[1] ? String(m[1]).toUpperCase() : '';
}

function beammpExtractConnectors(raw) {
	var out = [];
	function walk(x) {
		if (!x)
			return;
		if (Array.isArray(x)) {
			angular.forEach(x, walk);
			return;
		}
		if (typeof x !== 'object')
			return;
		if (Array.isArray(x.result)) {
			walk(x.result);
			return;
		}
		var url = beammpDeepPick(x, [/^url$/, /\.url$/, /peer.*url/, /connector.*url/]);
		if (url) {
			out.push({
				url: String(url),
				status: beammpNormalizeConnectorStatus(beammpDeepPick(x, [/^status$/, /connector.*status/]))
			});
			return;
		}
		angular.forEach(x, function(v, k) {
			var lk = String(k || '').toLowerCase();
			if (Array.isArray(v) && (lk === 'result' || lk.indexOf('connector') !== -1))
				walk(v);
		});
	}
	walk(raw);
	return out;
}

function beammpMergePeerRows(peers, connectors, configuredPeers) {
	var out = [];
	var seen = {};
	function push(row) {
		if (!row)
			return;
		var k = (String(row.virtualIp || '') + '|' + String(row.hostname || '')).toLowerCase();
		if (k === '|')
			return;
		if (seen[k])
			return;
		seen[k] = true;
		out.push(row);
	}
	angular.forEach(peers || [], push);
	angular.forEach(connectors || [], function(c) {
		var url = String(c.url || '').trim();
		if (!url.length)
			return;
		var status = String(c.status || '').trim();
		push({
			virtualIp: '',
			hostname: url,
			route: status ? ('relay(' + status + ')') : 'relay',
			protocol: beammpProtocolFromUrl(url),
			latency: '',
			up: '',
			down: '',
			loss: '',
			natType: '',
			version: ''
		});
	});
	angular.forEach(configuredPeers || [], function(urlRaw) {
		var url = String(urlRaw || '').trim();
		if (!url.length)
			return;
		push({
			virtualIp: '',
			hostname: url,
			route: 'configured',
			protocol: beammpProtocolFromUrl(url),
			latency: '',
			up: '',
			down: '',
			loss: '',
			natType: '',
			version: ''
		});
	});
	return out;
}

function beammpNormalizeEtInfo(etInfo) {
	if (!etInfo || typeof etInfo !== 'object')
		return null;
	var peersRaw = beammpEtToArray(etInfo.peers);
	var peers = peersRaw.map(function(p) {
		if (!p || typeof p !== 'object')
			return {};
		return {
			virtualIp: beammpDeepPick(p, [/^cidr$/, /^ipv4_addr$/, /route.*ipv4_addr/, /virtual.*ipv4/, /virtual.*ip/, /^ipv4$/, /^ip$/]),
			hostname: beammpDeepPick(p, [/^hostname$/, /host.*name/]),
			route: beammpDeepPick(p, [/^cost$/, /path_len/, /path_latency/, /next_hop/, /^route$/, /path/, /relay/, /link.*type/]),
			protocol: beammpDeepPick(p, [/tunnel.*proto/, /tunnel/, /^proto$/, /protocol/, /transport/]),
			latency: beammpDeepPick(p, [/^lat_ms$/, /latency/, /^rtt$/, /ping/]),
			up: beammpDeepPick(p, [/^tx_bytes$/, /^tx$/, /upload/, /tx_?bytes/, /sent/]),
			down: beammpDeepPick(p, [/^rx_bytes$/, /^rx$/, /download/, /rx_?bytes/, /recv/]),
			loss: beammpDeepPick(p, [/^loss_rate$/, /loss_rate/, /loss/, /drop/]),
			natType: beammpDeepPick(p, [/^nat_type$/, /nat.*type/]),
			version: beammpDeepPick(p, [/^version$/, /core.*version/, /build.*version/])
		};
	});
	var connectors = beammpExtractConnectors(etInfo.connectors);
	var configuredPeers = [];
	angular.forEach(beammpEtToArray(etInfo.configuredPeers), function(x) {
		var s = String(x || '').trim();
		if (s.length)
			configuredPeers.push(s);
	});
	peers = beammpMergePeerRows(peers, connectors, configuredPeers);
	var node = etInfo.node && typeof etInfo.node === 'object' ? etInfo.node : {};
	var built = beammpBuildNodeSummary(node, peers);
	return {
		scope: etInfo.scope || '',
		roomId: etInfo.roomId || '',
		nodeRaw: node,
		nodeLine1: built.line1,
		nodeLine2: built.line2,
		serverInfo: etInfo.serverInfo || null,
		serverHostIp: etInfo.serverHostIp || '',
		serverHostPort: etInfo.serverHostPort || '',
		peers: peers
	};
}

var BEAMMP_DEFAULT_ET_PEERS = 'et1.fuis.top:11010';

function beammpBuildEtOptionDefs($translate) {
	var t = function(fb) { return beammpLocaleText($translate, fb); };
	return [
		{
			model: 'etDhcp',
			label: t({ zh: '启用 DHCP', zhHant: '啟用 DHCP', en: 'Enable DHCP' }),
			title: t({ zh: '--dhcp 自动分配虚拟 IP', zhHant: '--dhcp 自動分配虛擬 IP', en: '--dhcp auto-assign virtual IP' })
		},
		{
			model: 'etLatencyFirst',
			label: t({ zh: '开启延迟优先模式', zhHant: '開啟延遲優先模式', en: 'Enable latency-first mode' }),
			title: t({ zh: '--latency-first 使用最低延迟路径转发流量', zhHant: '--latency-first 使用最低延遲路徑轉發流量', en: '--latency-first forward traffic through lowest-latency path' })
		},
		{
			model: 'etUseSmoltcp',
			label: t({ zh: '使用用户态协议栈', zhHant: '使用使用者態協議棧', en: 'Use userspace TCP/IP stack' }),
			title: t({ zh: '--use-smoltcp 启用 smoltcp 用户态协议栈', zhHant: '--use-smoltcp 啟用 smoltcp 使用者態協議棧', en: '--use-smoltcp enable smoltcp userspace stack' })
		},
		{
			model: 'etDisableIpv6',
			label: t({ zh: '禁用 IPv6', zhHant: '禁用 IPv6', en: 'Disable IPv6' }),
			title: t({ zh: '--disable-ipv6 不使用 IPv6', zhHant: '--disable-ipv6 不使用 IPv6', en: '--disable-ipv6 disable IPv6' })
		},
		{
			model: 'etEnableKcpProxy',
			label: t({ zh: '启用 KCP 代理', zhHant: '啟用 KCP 代理', en: 'Enable KCP proxy' }),
			title: t({ zh: '--enable-kcp-proxy 使用 KCP 代理 TCP 流', zhHant: '--enable-kcp-proxy 使用 KCP 代理 TCP 流', en: '--enable-kcp-proxy proxy TCP streams over KCP' })
		},
		{
			model: 'etDisableKcpInput',
			label: t({ zh: '禁用 KCP 输入', zhHant: '禁用 KCP 輸入', en: 'Disable KCP input' }),
			title: t({ zh: '--disable-kcp-input 不允许其他节点对本节点使用 KCP 代理', zhHant: '--disable-kcp-input 不允許其他節點對本節點使用 KCP 代理', en: '--disable-kcp-input disallow inbound KCP proxy from peers' })
		},
		{
			model: 'etEnableQuicProxy',
			label: t({ zh: '启用 QUIC 代理', zhHant: '啟用 QUIC 代理', en: 'Enable QUIC proxy' }),
			title: t({ zh: '--enable-quic-proxy 使用 QUIC 代理 TCP 流', zhHant: '--enable-quic-proxy 使用 QUIC 代理 TCP 流', en: '--enable-quic-proxy proxy TCP streams over QUIC' })
		},
		{
			model: 'etDisableQuicInput',
			label: t({ zh: '禁用 QUIC 输入', zhHant: '禁用 QUIC 輸入', en: 'Disable QUIC input' }),
			title: t({ zh: '--disable-quic-input 不允许其他节点对本节点使用 QUIC 代理', zhHant: '--disable-quic-input 不允許其他節點對本節點使用 QUIC 代理', en: '--disable-quic-input disallow inbound QUIC proxy from peers' })
		},
		{
			model: 'etDisableP2p',
			label: t({ zh: '禁用 P2P', zhHant: '禁用 P2P', en: 'Disable P2P' }),
			title: t({ zh: '--disable-p2p 禁用 P2P，仅通过 --peers 节点转发', zhHant: '--disable-p2p 禁用 P2P，僅透過 --peers 節點轉發', en: '--disable-p2p disable P2P, relay only via --peers' })
		},
		{
			model: 'etBindDevice',
			label: t({ zh: '仅使用物理网卡', zhHant: '僅使用實體網卡', en: 'Bind physical NIC only' }),
			title: t({ zh: '--bind-device 绑定物理网卡避免路由问题', zhHant: '--bind-device 綁定實體網卡避免路由問題', en: '--bind-device bind physical NIC to avoid routing issues' })
		},
		{
			model: 'etNoTun',
			label: t({ zh: '无 TUN 模式', zhHant: '無 TUN 模式', en: 'No TUN mode' }),
			title: t({ zh: '--no-tun 不创建 TUN 设备', zhHant: '--no-tun 不建立 TUN 裝置', en: '--no-tun do not create TUN device' })
		},
		{
			model: 'etEnableExitNode',
			label: t({ zh: '启用出口节点', zhHant: '啟用出口節點', en: 'Enable exit node' }),
			title: t({ zh: '--enable-exit-node 允许本节点成为出口节点', zhHant: '--enable-exit-node 允許本節點成為出口節點', en: '--enable-exit-node allow this node to act as exit node' })
		},
		{
			model: 'etRelayAllPeerRpc',
			label: t({ zh: '转发 RPC 包', zhHant: '轉發 RPC 封包', en: 'Relay RPC packets' }),
			title: t({ zh: '--relay-all-peer-rpc 转发所有对端 RPC 包', zhHant: '--relay-all-peer-rpc 轉發所有對端 RPC 封包', en: '--relay-all-peer-rpc relay all peer RPC packets' })
		},
		{
			model: 'etMultiThread',
			label: t({ zh: '启用多线程', zhHant: '啟用多執行緒', en: 'Enable multithread' }),
			title: t({ zh: '--multi-thread 使用多线程运行时', zhHant: '--multi-thread 使用多執行緒運行時', en: '--multi-thread use multithread runtime' })
		},
		{
			model: 'etProxyForwardBySystem',
			label: t({ zh: '系统转发', zhHant: '系統轉發', en: 'System forwarding' }),
			title: t({ zh: '--proxy-forward-by-system 通过系统内核转发子网代理', zhHant: '--proxy-forward-by-system 透過系統核心轉發子網代理', en: '--proxy-forward-by-system forward subnet proxy via system kernel' })
		},
		{
			model: 'etDisableEncryption',
			label: t({ zh: '禁用加密', zhHant: '禁用加密', en: 'Disable encryption' }),
			title: t({ zh: '--disable-encryption 禁用加密（需与对端一致）', zhHant: '--disable-encryption 禁用加密（需與對端一致）', en: '--disable-encryption disable encryption (must match peers)' })
		},
		{
			model: 'etDisableUdpHolePunching',
			label: t({ zh: '禁用 UDP 打洞', zhHant: '禁用 UDP 打洞', en: 'Disable UDP hole punching' }),
			title: t({ zh: '--disable-udp-hole-punching 禁用 UDP 打洞', zhHant: '--disable-udp-hole-punching 禁用 UDP 打洞', en: '--disable-udp-hole-punching disable UDP hole punching' })
		},
		{
			model: 'etDisableSymHolePunching',
			label: t({ zh: '禁用对称 NAT 打洞', zhHant: '禁用對稱 NAT 打洞', en: 'Disable symmetric NAT punching' }),
			title: t({ zh: '--disable-sym-hole-punching 禁用对称 NAT 打洞', zhHant: '--disable-sym-hole-punching 禁用對稱 NAT 打洞', en: '--disable-sym-hole-punching disable symmetric NAT punching' })
		},
		{
			model: 'etAcceptDns',
			label: t({ zh: '启用魔法 DNS', zhHant: '啟用魔法 DNS', en: 'Enable Magic DNS' }),
			title: t({ zh: '--accept-dns 启用 Magic DNS，可用域名访问节点', zhHant: '--accept-dns 啟用 Magic DNS，可用網域名稱存取節點', en: '--accept-dns enable Magic DNS for domain-based node access' })
		},
		{
			model: 'etPrivateMode',
			label: t({ zh: '启用私有模式', zhHant: '啟用私有模式', en: 'Enable private mode' }),
			title: t({ zh: '--private-mode 不允许不同网络名/密码的节点握手或中继', zhHant: '--private-mode 不允許不同網路名稱/密碼的節點握手或中繼', en: '--private-mode disallow handshake/relay across different network name/password' })
		}
	];
}

var BEAMMP_ROOM_LIST_KEYS = {
	title: 'ui.multiplayer.rooms.title',
	hint: 'ui.multiplayer.rooms.hint',
	create: 'ui.multiplayer.rooms.create',
	empty: 'ui.multiplayer.rooms.empty',
	port: 'ui.multiplayer.rooms.port',
	start: 'ui.multiplayer.rooms.start',
	stop: 'ui.multiplayer.rooms.stop',
	edit: 'ui.multiplayer.rooms.edit',
	join: 'ui.multiplayer.rooms.join'
};

var BEAMMP_ROOM_LIST_FB = {
	title: { en: 'LAN rooms', zh: '局域网房间' },
	hint: {
		en: 'Create offline room configs. Start the server when ready, then Join on this PC (127.0.0.1). Guests use Direct connect with your LAN IP.',
		zh: '创建离线房间配置。需要时再启动服务端，本机点击「进入」会用 127.0.0.1 连接。其他玩家用你的局域网 IP 直连。'
	},
	create: { en: 'Create room', zh: '创建房间' },
	empty: { en: 'No saved rooms yet.', zh: '暂无已保存的房间。' },
	port: { en: 'Port', zh: '端口' },
	start: { en: 'Start server', zh: '启动服务' },
	stop: { en: 'Stop server', zh: '停止服务' },
	edit: { en: 'Edit', zh: '编辑' },
	join: { en: 'Join', zh: '进入' }
};

var BEAMMP_ROOM_FORM_KEYS = {
	pageTitleCreate: 'ui.multiplayer.rooms.createTitle',
	pageTitleEdit: 'ui.multiplayer.rooms.editTitle',
	fieldDisplayName: 'ui.multiplayer.rooms.fieldDisplayName',
	fieldServerName: 'ui.multiplayer.rooms.fieldServerName',
	fieldPort: 'ui.multiplayer.rooms.fieldPort',
	fieldMaxPlayers: 'ui.multiplayer.rooms.fieldMaxPlayers',
	fieldMaxCars: 'ui.multiplayer.rooms.fieldMaxCars',
	fieldMap: 'ui.multiplayer.rooms.fieldMap',
	fieldMapPath: 'ui.multiplayer.rooms.fieldMapPath',
	fieldDescription: 'ui.multiplayer.rooms.fieldDescription',
	fieldTags: 'ui.multiplayer.rooms.fieldTags',
	fieldBindIp: 'ui.multiplayer.rooms.fieldBindIp',
	fieldLogChat: 'ui.multiplayer.rooms.fieldLogChat',
	fieldInformationPacket: 'ui.multiplayer.rooms.fieldInformationPacket',
	fieldDebug: 'ui.multiplayer.rooms.fieldDebug',
	save: 'ui.multiplayer.rooms.save',
	cancel: 'ui.multiplayer.rooms.cancel'
};

var BEAMMP_ROOM_FORM_FB = {
	pageTitleCreate: { en: 'Create room', zh: '创建房间' },
	pageTitleEdit: { en: 'Edit room', zh: '编辑房间' },
	fieldDisplayName: { en: 'Room display name', zh: '房间显示名称' },
	fieldServerName: { en: 'Server list name (optional)', zh: '服务器名称（可选）' },
	fieldPort: { en: 'Game server port', zh: '游戏服务端端口' },
	fieldMaxPlayers: { en: 'Max players', zh: '最大玩家数' },
	fieldMaxCars: { en: 'Max cars per player', zh: '每位玩家最大车辆数' },
	fieldMap: { en: 'Map', zh: '地图' },
	fieldMapPath: { en: 'Map path (info.json or mission)', zh: '地图路径（info.json 或任务）' },
	fieldDescription: { en: 'Description', zh: '描述' },
	fieldTags: { en: 'Tags (comma-separated)', zh: '标签（逗号分隔）' },
	fieldBindIp: { en: 'Bind IP (0.0.0.0 for all interfaces)', zh: '绑定 IP（0.0.0.0 表示所有网卡）' },
	fieldLogChat: { en: 'Log chat to console', zh: '在控制台记录聊天' },
	fieldInformationPacket: { en: 'Information packet (server info without join)', zh: '信息包（未加入时可查询服务器信息）' },
	fieldDebug: { en: 'Server debug', zh: '服务端调试' },
	save: { en: 'Save', zh: '保存' },
	cancel: { en: 'Cancel', zh: '取消' }
};

angular.module('BeamNG.ui')
.run(function($rootScope, $templateCache) {
  $rootScope.$on('$stateChangeStart', function(event, toState, toParams, fromState, fromParams) {
    if (toState.name === 'loading' || fromState.name === 'loading') {
      $templateCache.remove('/ui/modules/loading/loading.html');
    }
  });
});

export default angular.module('multiplayer', ['ui.router'])
.config(['$stateProvider', function($stateProvider) {
  $stateProvider.state('menu.multiplayer', {
		url: '/multiplayer',
		templateUrl: '/ui/modModules/multiplayer/multiplayer.html',
		controller: 'MultiplayerController as multiplayer',
		backState: 'BACK_TO_MENU',
		abstract: true
	})
	.state('menu.multiplayer.tos', {
		url: '/mptos',
		templateUrl: '/ui/modModules/multiplayer/tos.partial.html',
		controller: 'MultiplayerTOSController as multiplayertos',
		backState: 'BACK_TO_MENU'
	})
	.state('menu.multiplayer.launcher', {
		url: '/mplauncher',
		templateUrl: '/ui/modModules/multiplayer/launcher.partial.html',
		controller: 'MultiplayerLauncherController as multiplayerlauncher',
		backState: 'BACK_TO_MENU'
	})
	.state('menu.multiplayer.login', {
		url: '/mplogin',
		templateUrl: '/ui/modModules/multiplayer/login.partial.html',
		controller: 'MultiplayerLoginController as multiplayerlogin',
		backState: 'BACK_TO_MENU'
	})
	.state('menu.multiplayer.servers', {
		url: '/mpservers',
		templateUrl: '/ui/modModules/multiplayer/servers.partial.html',
		controller: 'MultiplayerServersController as multiplayermenu',
		backState: 'BACK_TO_MENU'
	})
	.state('menu.multiplayer.direct', {
		url: '/mpdirect',
		templateUrl: '/ui/modModules/multiplayer/direct.partial.html',
		controller: 'MultiplayerDirectController as multiplayermenu',
		backState: 'BACK_TO_MENU'
	})
	.state('menu.multiplayer.rooms', {
		url: '/mprooms',
		templateUrl: '/ui/modModules/multiplayer/rooms.partial.html',
		controller: 'MultiplayerRoomsController as roomsVm',
		backState: 'BACK_TO_MENU'
	})
	.state('menu.multiplayer.roomCreate', {
		url: '/mproomcreate',
		templateUrl: '/ui/modModules/multiplayer/roomForm.partial.html',
		controller: 'MultiplayerRoomFormController as roomFormVm',
		backState: 'BACK_TO_MENU'
	})
	.state('menu.multiplayer.roomEdit', {
		url: '/mproomedit/:roomId',
		templateUrl: '/ui/modModules/multiplayer/roomForm.partial.html',
		controller: 'MultiplayerRoomFormController as roomFormVm',
		backState: 'BACK_TO_MENU'
	})
	.state('menu.multiplayer.guestRoomCreate', {
		url: '/mpguestroomcreate',
		templateUrl: '/ui/modModules/multiplayer/guestRoomForm.partial.html',
		controller: 'MultiplayerGuestRoomFormController as guestRoomFormVm',
		backState: 'BACK_TO_MENU'
	})
	.state('menu.multiplayer.guestRoomEdit', {
		url: '/mpguestroomedit/:roomId',
		templateUrl: '/ui/modModules/multiplayer/guestRoomForm.partial.html',
		controller: 'MultiplayerGuestRoomFormController as guestRoomFormVm',
		backState: 'BACK_TO_MENU'
	})
	.state('menu.options.multiplayer', {
		url: '/multiplayer',
		templateUrl: '/ui/modules/options/multiplayer.partial.html',
		backState: 'BACK_TO_MENU',
	})

}])

.run(['$rootScope', '$state', '$timeout', function ($rootScope, $state, $timeout) {
  $rootScope.$on('MainMenuButtons', function (event, addButton) {
    addButton({
      translateid: 'ui.playmodes.multiplayer',
      icon: '/ui/modModules/multiplayer/icons/account-multiple.svg',
      targetState: 'menu.multiplayer.tos'
    })
  })

  // Launcher offline mode answers Nc with Auth=1 before the login view exists; child $scope never sees LoggedIn.
  $rootScope.$on('LoggedIn', function () {
    $timeout(function () {
      if ($state.includes('menu.multiplayer')) {
        $state.go('menu.multiplayer.direct');
      }
    }, 0);
  })

	// Check for server to join
	$rootScope.$on('AutoJoinConfirmation', function(evt, data) {
		console.log('AutoJoinConfirmation',evt,data)
		var d = JSON.parse(decodeURI(data.message))
		confirmationMessage = `Do you want to connect to the server at ${d.ip}:${d.port}?`
		userConfirmed = window.confirm(confirmationMessage); 
		if (userConfirmed) {
			bngApi.engineLua(`MPCoreNetwork.connectToServer("${d.ip}","${d.port}","${d.sname}")`);
		}
	})

	var beammpUserInfo = document.createElement("div");
	beammpUserInfo.innerHTML = `
	<style>
.beammp-info-bar {
  z-index: 96;
  position: absolute;
  top: 3em;
  right: 0;
  padding-left: 1.2rem;
  display: flex;
  flex-direction: row;
  align-items: center;
  margin-right: 3em;
  padding-right: 10px;
  background-image: linear-gradient(67deg,transparent 1.05rem,#f60 1.15rem 1.4rem,#00000099 1.5rem);
  border-top-right-radius: var(--bng-corners-1);
  border-bottom-right-radius: var(--bng-corners-1);
  color: #fff;
  pointer-events: all;
  height: 2.9em;
  line-height: 2.9em;
  overflow: hidden;
}

.beammp-info-bar > span.divider {
  display: inline-block;
  width: .25rem;
  height: 1.8em;
  margin-left: .5rem;
  margin-right: .2rem;
  padding: 0!important;
  background-color: #f60;
  transform: skew(23deg);
}
	</style>
	<div class="beammp-info-bar">
		<img src="/ui/modModules/multiplayer/beammp.png" style="padding-left: .5rem; margin: 0px 8px;" height="32px">
		<span class="divider"></span>
		<img src="/ui/modModules/multiplayer/icons/account-multiple.svg" style="padding: 5px" height="22px">
		<span style="padding-left: 5px; padding-right: 10px;">Players: <strong id="beammpMetricsPlayers">${ beammpMetrics.players }</strong> </span>
		<img src="/ui/modModules/multiplayer/icons/dns.svg" style="padding: 5px" height="22px">
		<span style="padding-left: 5px;">Servers: <strong id="beammpMetricsServers">${ beammpMetrics.servers }</strong> </span>
		<span class="divider" id="beammp-profile-divider"></span>
		<span><strong id="beammp-profile-name">${userData.username}</strong> </span>
	</div>
	`
	var beammpModInfo = document.createElement("div");
	beammpModInfo.innerHTML = `
		<span class="divider"></span>
		<span style="margin-right: 5px;">
			<span>BeamMP v<span id="beammpModVersion">${beammpMetrics.beammpGameVer}</span></span>
		</span>
	`
	beammpModInfo.id = 'BeamMPVersionInject'

	$rootScope.$on('authReceived', function (event, data) {	
		let nameElement = document.getElementById("beammp-profile-name")
		let divider = document.getElementById("beammp-profile-divider")

		if (!nameElement || !divider)
			return;

		userData = {
			username: data.username,
			role: data.role,
			color: data.color,
			id: data.id
		};

		nameElement.textContent = data.username || '';

		if (!data.username) {
			divider.style.display = 'none'
			nameElement.style.display = 'none'
		} else if (window.location.href.includes("menu.mainmenu")) {
			divider.style.display = 'block'
			nameElement.style.display = 'block';
		}
	})

	$rootScope.$on('BeamMPInfo', function (event, data) {
		beammpMetrics = data	
		injectVersion()
		document.getElementById("beammpMetricsPlayers").textContent = beammpMetrics.players
		document.getElementById("beammpMetricsServers").textContent = beammpMetrics.servers

		document.getElementById("beammpModVersion").textContent = beammpMetrics.beammpGameVer
	})

	function injectVersion() {
		if (document.querySelector('#vue-app > div.vue-app-main.click-through > div.info-bar > div.info-bar-stats'))
			document.querySelector('#vue-app > div.vue-app-main.click-through > div.info-bar > div.info-bar-stats').appendChild(beammpModInfo);
	}

	$rootScope.$on('$stateChangeSuccess', async function (event, toState, toParams, fromState, fromParams) {
		//console.log(`Going from "${fromState.name}" -> "${toState.name}"`)
		if (toState.name == "menu.mainmenu") {
			bngApi.engineLua('MPCoreNetwork.getLoginState()');
			bngApi.engineLua('MPCoreNetwork.sendBeamMPInfo()');
			beammpUserInfo.style.display = "block";
			let userinfo =  document.getElementsByTagName("body")[0].appendChild(beammpUserInfo).children[1]
			//console.log(userinfo)
			userinfo.style = null


			let nameElement = document.getElementById("beammp-profile-name");
			let divider = document.getElementById("beammp-profile-divider");

			if (nameElement) {
				nameElement.style.display = "block";
				console.log('name shown', nameElement)
			}
			if (divider) {
				divider.style.display = "block";
			}

			injectVersion()
		} else if (toState.name.includes("menu.multiplayer")) {
			bngApi.engineLua('MPCoreNetwork.sendBeamMPInfo()');
			beammpUserInfo.style.display = "block";
			let userinfo =  document.getElementsByTagName("body")[0].appendChild(beammpUserInfo).children[1]
			userinfo.style.marginRight = "0"
			userinfo.style.top = "0"
			userinfo.style.lineHeight = "2.4em"
			userinfo.style.height = "2.4em"


			let nameElement = document.getElementById("beammp-profile-name");
			let divider = document.getElementById("beammp-profile-divider");

			if (nameElement) {
				nameElement.style.display = "none";
				console.log('name hidden', nameElement)
			}
			if (divider) {
				divider.style.display = "none";
			}

			
			//console.log('Adding Mod Version Info')
			injectVersion()
		} else {
			beammpUserInfo.style.display = "none";
		}
  })
}])

/* //////////////////////////////////////////////////////////////////////////////////////////////
*	TOS CONTROLLER
*/ //////////////////////////////////////////////////////////////////////////////////////////////
.controller('MultiplayerTOSController', ['$scope', '$state', '$timeout', '$document', 
function($scope, $state, $timeout, $document) {
	'use strict';

	$scope.$on('$stateChangeSuccess', async function (event, toState, toParams, fromState, fromParams) {

		// Check if the user as acknowledged tos
		const tosAccepted = localStorage.getItem("tosAccepted");
		if (tosAccepted == "true") {
			$state.go('menu.multiplayer.direct');
			return;
		}
	});

	// The lua setting need to be functional before we redirect, otherwise we'll land here again.
	// for that reason, we listen for the settings changed event that will ensure that the main menu will not get back here again
	$scope.validate = function () {
		localStorage.setItem("tosAccepted", "true");
		bngApi.engineLua(`MPConfig.acceptTos()`);
		$state.go('menu.multiplayer.direct');
	};

	$scope.openExternalLink = function(url) {
		bngApi.engineLua(`MPCoreNetwork.openURL("`+url+`")`);
	}

	bngApi.engineLua(`MPConfig.getConfig()`, (data) => {
		if (data != null) {
			if (!localStorage.getItem("tosAccepted")) {
				localStorage.setItem("tosAccepted", data.tos);
				$state.go('menu.multiplayer.direct');
			}
		}
	});
}])



/* //////////////////////////////////////////////////////////////////////////////////////////////
*	LAUNCHER CONNECTION CONTROLLER
*/ //////////////////////////////////////////////////////////////////////////////////////////////
.controller('MultiplayerLauncherController', ['$scope', '$state', '$timeout', '$document', 
function($scope, $state, $timeout, $document) {
	'use strict';
	// The lua setting need to be functional before we redirect, otherwise we'll land here again.
	// for that reason, we listen for the settings changed event that will ensure that the main menu will not get back here again
	$scope.connect = function () {
		bngApi.engineLua('MPCoreNetwork.connectToLauncher()');
	};
	
	$scope.$on('onLauncherConnected', function (event, data) {
		$state.go('menu.multiplayer.login');
	});
	
	// The game's lua has an auto launcher reconnect in case
}])



/* //////////////////////////////////////////////////////////////////////////////////////////////
*	LOGIN CONTROLLER
*/ //////////////////////////////////////////////////////////////////////////////////////////////
.controller('MultiplayerLoginController', ['$scope', '$state', '$timeout', '$document', '$translate',
function($scope, $state, $timeout, $document, $translate) {
	'use strict';
	var vm = this;
	$scope.loginSubmitting = false;
	var loginSubmitTimeout = null;

	function clearLoginSubmitLock() {
		if (loginSubmitTimeout) {
			$timeout.cancel(loginSubmitTimeout);
			loginSubmitTimeout = null;
		}
		$scope.loginSubmitting = false;
	}

	$scope.confirmUsername = function() {
		if ($scope.loginSubmitting)
			return;
		var errEl = document.getElementById('LOGINERRORFIELD');
		if (errEl)
			errEl.textContent = '';
		var inp = document.getElementById('mpUsernameInput');
		if (!inp)
			return;
		var raw = inp.value.trim();
		if (!raw.length) {
			if (errEl)
				errEl.textContent = $translate.instant('ui.multiplayer.usernameRequired');
			return;
		}
		if (!/^[a-zA-Z0-9_]{1,32}$/.test(raw)) {
			if (errEl)
				errEl.textContent = $translate.instant('ui.multiplayer.usernameInvalid');
			return;
		}
		$scope.loginSubmitting = true;
		if (loginSubmitTimeout)
			$timeout.cancel(loginSubmitTimeout);
		loginSubmitTimeout = $timeout(function () {
			loginSubmitTimeout = null;
			$scope.loginSubmitting = false;
			bngApi.engineLua('MPCoreNetwork.cancelLogin()');
			if (errEl)
				errEl.textContent = $translate.instant('ui.multiplayer.loginTimeout');
		}, 15000);
		localStorage.setItem('beammpOfflineUsername', raw);
		var guest = { Guest: raw };
		bngApi.engineLua('MPCoreNetwork.login(' + bngApi.serializeToLua(guest) + ')');
	};

	$timeout(function () {
		var inp = document.getElementById('mpUsernameInput');
		if (!inp)
			return;
		var saved = localStorage.getItem('beammpOfflineUsername');
		if (saved)
			inp.value = saved;
	}, 0);
	
	$scope.$on('LoggedIn', function (event, data) {
		clearLoginSubmitLock();
		$state.go('menu.multiplayer.direct');
	});
	
	$scope.$on('LoginError', function (event, data) {
		clearLoginSubmitLock();
		var errEl = document.getElementById('LOGINERRORFIELD');
		if (errEl)
			errEl.textContent = data || '';
	});
	
	//Workaround for sticky login UI
	$scope.$on('actuallyLoggedIn', function (event, data) {
		if (data == true) {
			clearLoginSubmitLock();
			$state.go('menu.multiplayer.direct');
		}
	});
	bngApi.engineLua('MPCoreNetwork.isLoggedIn()');
}])



/* //////////////////////////////////////////////////////////////////////////////////////////////
*	MAIN CONTROLLER
*/ //////////////////////////////////////////////////////////////////////////////////////////////
.controller('MultiplayerController', ['$scope', '$state', '$timeout', '$mdDialog', '$filter', 'ConfirmationDialog', 'toastr', '$translate', '$interval',
function($scope, $state, $timeout, $mdDialog, $filter, ConfirmationDialog, toastr, $translate, $interval) {
	var vm = this;
	bngApi = bngApi;
	mdDialog = $mdDialog;
	var tr = function(fb) { return beammpLocaleText($translate, fb); };

	function applyDirectI18n() {
		vm.i18nDirect = {
			error: tr({ zh: '错误', zhHant: '錯誤', en: 'Error' }),
			info: tr({ zh: '提示', zhHant: '提示', en: 'Info' }),
			navGuestMode: tr({ zh: '访客模式', zhHant: '訪客模式', en: 'Guest Mode' }),
			navHostMode: tr({ zh: '房主模式', zhHant: '房主模式', en: 'Host Mode' }),
			newGuestRoomConfig: tr({ zh: '新建房间配置', zhHant: '建立房間設定', en: 'New Room Config' }),
			rooms: tr({ zh: '房间', zhHant: '房間', en: 'Rooms' }),
			noGuestRooms: tr({ zh: '暂无房间配置', zhHant: '暫無房間設定', en: 'No room configs' }),
			port: tr({ zh: '端口', zhHant: '連接埠', en: 'Port' }),
			password: tr({ zh: '密码', zhHant: '密碼', en: 'Password' }),
			publicNodes: tr({ zh: '公共节点', zhHant: '公共節點', en: 'Public Nodes' }),
			none: tr({ zh: '无', zhHant: '無', en: 'None' }),
			joinRoom: tr({ zh: '加入房间', zhHant: '加入房間', en: 'Join Room' }),
			leaveRoom: tr({ zh: '退出房间', zhHant: '退出房間', en: 'Leave Room' }),
			leaving: tr({ zh: '退出中...', zhHant: '退出中...', en: 'Leaving...' }),
			enterGame: tr({ zh: '进入游戏', zhHant: '進入遊戲', en: 'Enter Game' }),
			edit: tr({ zh: '编辑', zhHant: '編輯', en: 'Edit' }),
			delete: tr({ zh: '删除', zhHant: '刪除', en: 'Delete' }),
			confirmDelete: tr({ zh: '确认删除', zhHant: '確認刪除', en: 'Confirm Delete' }),
			serverInfo: tr({ zh: 'BeamMP 服务器信息', zhHant: 'BeamMP 伺服器資訊', en: 'BeamMP Server Info' }),
			name: tr({ zh: '名称', zhHant: '名稱', en: 'Name' }),
			map: tr({ zh: '地图', zhHant: '地圖', en: 'Map' }),
			players: tr({ zh: '玩家', zhHant: '玩家', en: 'Players' }),
			description: tr({ zh: '描述', zhHant: '描述', en: 'Description' }),
			version: tr({ zh: '版本', zhHant: '版本', en: 'Version' }),
			unknown: tr({ zh: '未知', zhHant: '未知', en: 'Unknown' }),
			nodeInfo: tr({ zh: '节点信息', zhHant: '節點資訊', en: 'Node Info' }),
			session: tr({ zh: '会话', zhHant: '會話', en: 'Session' }),
			room: tr({ zh: '房间', zhHant: '房間', en: 'Room' }),
			nodeCount: tr({ zh: '节点数', zhHant: '節點數', en: 'Nodes' }),
			virtualIpv4: tr({ zh: '虚拟IPv4', zhHant: '虛擬IPv4', en: 'Virtual IPv4' }),
			hostname: tr({ zh: '主机名', zhHant: '主機名', en: 'Hostname' }),
			route: tr({ zh: '路由', zhHant: '路由', en: 'Route' }),
			protocol: tr({ zh: '协议', zhHant: '協議', en: 'Protocol' }),
			latency: tr({ zh: '延迟', zhHant: '延遲', en: 'Latency' }),
			upload: tr({ zh: '上传', zhHant: '上傳', en: 'Upload' }),
			download: tr({ zh: '下载', zhHant: '下載', en: 'Download' }),
			loss: tr({ zh: '丢包率', zhHant: '丟包率', en: 'Loss' }),
			natType: tr({ zh: 'NAT类型', zhHant: 'NAT類型', en: 'NAT Type' }),
			noNodeData: tr({ zh: '暂无节点数据（展开时自动刷新）', zhHant: '暫無節點資料（展開時自動刷新）', en: 'No node data (auto refresh on expand)' }),
			servers: tr({ zh: '服务器', zhHant: '伺服器', en: 'Servers' }),
			noServers: tr({ zh: '暂无服务器配置', zhHant: '暫無伺服器設定', en: 'No server configs' }),
			connect: tr({ zh: '连接', zhHant: '連線', en: 'Connect' }),
			serverNote: tr({ zh: '服务器备注（默认空）', zhHant: '伺服器備註（預設為空）', en: 'Server Note (default empty)' }),
			ip: 'IP',
			portShort: tr({ zh: '端口', zhHant: '連接埠', en: 'Port' }),
			save: tr({ zh: '保存', zhHant: '儲存', en: 'Save' }),
			cancel: tr({ zh: '取消', zhHant: '取消', en: 'Cancel' }),
			ipRequired: tr({ zh: 'IP 不能为空', zhHant: 'IP 不能為空', en: 'IP cannot be empty' }),
			portInvalid: tr({ zh: '端口无效', zhHant: '連接埠無效', en: 'Invalid port' }),
			waitLeaving: tr({ zh: '正在退出房间，请稍候', zhHant: '正在退出房間，請稍候', en: 'Leaving room, please wait' }),
			roomEditingJoined: tr({ zh: '该房间正在连接中，请先退出再编辑', zhHant: '該房間連線中，請先退出再編輯', en: 'This room is connected. Leave before editing.' }),
			serverIpInvalid: tr({ zh: '服务器 IP 配置无效', zhHant: '伺服器 IP 設定無效', en: 'Invalid server IP config' }),
			stopHostFirst: tr({ zh: '请先关闭房间服务', zhHant: '請先關閉房間服務', en: 'Please stop host service first' }),
			leaveCurrentRoomFirst: tr({ zh: '请先退出当前房间', zhHant: '請先退出目前房間', en: 'Please leave current room first' }),
			hostOffline: tr({ zh: '房主未上线', zhHant: '房主未上線', en: 'Host is offline' }),
			guestStartFailed: tr({ zh: '访客网络启动失败，请先关闭你作为房主启动的房间服务', zhHant: '訪客網路啟動失敗，請先關閉你作為房主啟動的房間服務', en: 'Guest network start failed. Stop your host service first.' }),
			timeout: tr({ zh: '检测超时', zhHant: '檢測逾時', en: 'Check timed out' }),
			joinRoomFirst: tr({ zh: '请先加入房间', zhHant: '請先加入房間', en: 'Please join room first' }),
			stopServiceBeforeEdit: tr({ zh: '请先停止服务', zhHant: '請先停止服務', en: 'Please stop service first' }),
			roomRunningStopBeforeEdit: tr({ zh: '该房间正在运行，请先停止服务再编辑', zhHant: '該房間正在運行，請先停止服務再編輯', en: 'Room is running. Stop service before editing.' }),
			leaveBeforeEdit: tr({ zh: '该房间正在连接中，请先退出再编辑', zhHant: '該房間連線中，請先退出再編輯', en: 'Room is connected. Leave before editing.' }),
			leaveRoomFirst: tr({ zh: '请先退出房间', zhHant: '請先退出房間', en: 'Please leave room first' }),
			stopBeforeDelete: tr({ zh: '请先停止服务再删除', zhHant: '請先停止服務再刪除', en: 'Stop service before deleting' }),
			leaveBeforeDelete: tr({ zh: '请先退出房间再删除', zhHant: '請先退出房間再刪除', en: 'Leave room before deleting' }),
			serverFull: tr({ zh: '服务器已满', zhHant: '伺服器已滿', en: 'Server is full' }),
			joinedGuest: tr({ zh: '已加入房间网络', zhHant: '已加入房間網路', en: 'Joined room network' }),
			leftGuest: tr({ zh: '已退出房间网络', zhHant: '已退出房間網路', en: 'Left room network' }),
			copiedId: tr({ zh: '已复制ID到剪贴板', zhHant: '已複製 ID 到剪貼簿', en: 'Copied ID to clipboard' })
		};
	}
	applyDirectI18n();
	$scope.$on('$translateChangeSuccess', function() {
		applyDirectI18n();
		$scope.$evalAsync();
	});

	$scope.switchServerView = function(view) {
		var serversTableContainer = document.getElementById("serversTableContainer");
		if (serversTableContainer) {
			serversTableContainer.scrollTop = 0;
		}
		serverView = view;
		$state.go('menu.multiplayer.servers');
		repopulateServerList();

		var buttons = document.getElementsByClassName("servers-btn");
		for (var i = 0; i < buttons.length; i++) {
			buttons[i].classList.remove("md-primary");
			buttons[i].classList.remove("md-raised");
		}
		var tabBtn = document.getElementById(view + "-servers-btn");
		if (tabBtn) {
			tabBtn.classList.add("md-primary");
			tabBtn.classList.add("md-raised");
		}

		var ex = document.getElementById("extra-button");
		if (ex)
			ex.style.display = "none";
	}

	// Trigger Warning Prompt
	$scope.$on('DownloadSecurityPrompt', function (event, data) {
		var o = true
		ConfirmationDialog.open(
			"ui.multiplayer.security.title", "ui.multiplayer.security.prompt",
			[
				{ label: "ui.multiplayer.security.no_return", key: false, isCancel: true },
				// { label: "Enter and don't show this again", key: true },
				{ label: "ui.multiplayer.security.accept_proceed", key: true, default: true },
			],
			{ class: "experimental" }
		).then(res => {
			if (res) {
				o = false
				bngApi.engineLua(`MPCoreNetwork.approveModDownload()`);
			}
			if (o) {
				o = false
				bngApi.engineLua(`MPCoreNetwork.rejectModDownload()`);
				vm.closeLoadingPopup()
			}			
		});
	})

	// Display the servers list page once the page is loaded
	$scope.$on('$stateChangeSuccess', async function (event, toState, toParams, fromState, fromParams) {
		bngApi.engineLua('MPCoreNetwork.getLoginState()');
		if (toState.url == "/multiplayer") {
			$timeout(function() { $state.go('menu.multiplayer.direct'); }, 0);
		}

		// Check if the user as aknowledged tos
		const tosAccepted = localStorage.getItem("tosAccepted");
		//console.log(toState.url);
		if (tosAccepted != "true") {
			$state.go('menu.multiplayer.tos');
			return;
		}

		// Check launcher is not connected
		const launcherConnected = await isLauncherConnected();
		if (!launcherConnected) {
			$state.go('menu.multiplayer.launcher');
			return;
		}

		// Check if we are logged in
		const loggedIn = await isLoggedIn();
		if (!loggedIn) {
			$state.go('menu.multiplayer.login');
			return;
		}
	});
	
	$scope.$on('LauncherConnectionLost', function (event, data) {
		$state.go('menu.multiplayer.launcher');
	});

	$scope.$on('showMdDialog', function (event, data) {
		switch (data.dialogtype) {
			case "alert":
				if (mdDialogVisible) { return; }
				mdDialogVisible = true;

				$mdDialog.show({
					template: `
    <md-dialog aria-label="Alert Dialog"
               style="display: flex; flex-direction: column; padding: 24px;">
      <div style="font-size: 24px; color: white; margin-bottom: 16px;">
        ${data.title}
      </div>
      <div style="font-size: 16px; color: white; margin-bottom: 24px;">
        ${data.text}
      </div>
      <div style="display: flex; justify-content: flex-end;">
        <md-button ng-click="continueOffline()" class="md-primary" style="color: white;">Continue offline</md-button>
        <md-button ng-click="close()" class="md-primary" style="color: white;">
          ${data.okText}
        </md-button>
      </div>
    </md-dialog>
  `,
					controller: function ($scope, $mdDialog) {
						$scope.close = function () {
							$mdDialog.hide();
							mdDialogVisible = false;

							if (data.okJS !== undefined) {
								eval(data.okJS);
								return;
							} else if (data.okLua !== undefined) {
								bngApi.engineLua(data.okLua);
								return;
							}
						};
						$scope.continueOffline = function () {
							$mdDialog.hide();
							mdDialogVisible = false;
						};
					}
				}).then(function () {
					mdDialogVisible = false;
				});

				break;
		}
	});

	$scope.$on('onServerJoined', function (event, data) {
		$state.go('play');
	});

	$scope.logout = function() {
		localStorage.removeItem('beammpOfflineUsername');
		bngApi.engineLua(`MPCoreNetwork.logout()`);
		$state.go('menu.multiplayer.login');
	}

	vm.modelChanged = function($event) {
		var src = event.srcElement;
		//console.log(src.value);
	}

	vm.refreshList = function() {
		//console.log("Attempting to refresh server list.")
		bngApi.engineLua('MPCoreNetwork.requestServerList()');
	}

	vm.directConnect = function() {
		let modlist = document.getElementById('mod-download-list');
		if (modlist) {
			modlist.style.display = 'none';
		}

		vm.loadingStatus = ""
		vm.downloadingMods = [];
		$scope.$applyAsync();

		document.getElementById('loadingstatus-divider').style.display = "none";
		document.getElementById('LoadingStatus').innerText = "";

		//console.log('Clicked')
		var ip = document.getElementById('directip').value.trim();
		var port = document.getElementById('directport').value.trim();
		document.getElementById('LoadingServer').style.display = 'flex';
		bngApi.engineLua(`MPCoreNetwork.connectToServer("${ip}","${port}")`);
	};

	vm.closeLoadingPopup =  function() {
		document.getElementById('OriginalLoadingStatus').removeAttribute("hidden");
		document.getElementById('LoadingStatus').setAttribute("hidden", "hidden");
		document.getElementById('LoadingStatus').innerText = "";
		document.getElementById('loadingstatus-divider').style.display = 'none';
		document.getElementById('LoadingServer').style.display = 'none';
		vm.downloadingMods.length = 0;
		vm.downloadingMods = [];
		vm.loadingStatus = "";
		lastModInfo = '';
		bngApi.engineLua('MPCoreNetwork.leaveServer()');
	};


	vm.guestRooms = [];
	vm.savedServers = [];
	vm.joinedGuestRoomId = '';
	vm.hostRunning = false;
	vm.guestEtInfoByRoomId = {};
	vm.guestServerInfoByRoomId = {};
	vm.guestStopPending = false;
	vm.guestEtInfoInFlight = false;
	vm.directRoomsOpen = false;
	vm.directServersOpen = false;
	vm.guestEtPanelOpen = {};
	vm.savedServerEditId = '';
	vm.savedServerEditForm = { displayName: '', serverIp: '', port: 30814 };
	vm.pendingDeleteId = '';
	var pendingDeleteTimer = null;

	vm.toggleGuestEtPanel = function(id) {
		vm.guestEtPanelOpen[id] = !vm.guestEtPanelOpen[id];
	};

	vm.confirmDelete = function(id) {
		if (vm.pendingDeleteId === id) {
			vm.pendingDeleteId = '';
			if (pendingDeleteTimer) { $timeout.cancel(pendingDeleteTimer); pendingDeleteTimer = null; }
			vm.deleteSavedConfig(id);
			return;
		}
		vm.pendingDeleteId = id;
		if (pendingDeleteTimer) $timeout.cancel(pendingDeleteTimer);
		pendingDeleteTimer = $timeout(function() { vm.pendingDeleteId = ''; }, 3000);
	};
	var guestEtInfoLastReqMs = 0;

	function refreshSavedConfigs() {
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('LIST') + ')');
	}

	function parsePort(raw, fallback) {
		var p = parseInt(raw, 10);
		if (!isFinite(p) || p < 1 || p > 65535)
			return fallback;
		return p;
	}

	vm.directConnectFavorite = function() {
		var ip = (document.getElementById('directip').value || '').trim();
		var port = parsePort((document.getElementById('directport').value || '').trim(), 30814);
		if (!ip.length) {
			toastr.error(vm.i18nDirect.ipRequired, vm.i18nDirect.error, { timeOut: 3500, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		var payload = {
			kind: 'savedServer',
			displayName: '',
			name: '',
			serverIp: ip,
			port: port
		};
		bngApi.engineLua('MPCoreNetwork.roomHostSave(' + bngApi.serializeToLua(JSON.stringify(payload)) + ')');
	};

	vm.goGuestRoomCreate = function() {
		$state.go('menu.multiplayer.guestRoomCreate');
	};

	vm.goGuestRoomEdit = function(id) {
		if (vm.guestStopPending) {
			toastr.info(vm.i18nDirect.waitLeaving, vm.i18nDirect.info, { timeOut: 2000, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		if (vm.joinedGuestRoomId && String(vm.joinedGuestRoomId) === String(id)) {
			toastr.error(vm.i18nDirect.roomEditingJoined, vm.i18nDirect.error, { timeOut: 3500, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		$state.go('menu.multiplayer.guestRoomEdit', { roomId: id });
	};

	vm.connectSavedServer = function(s) {
		var ip = (s.serverIp || '').trim();
		var port = parsePort(s.port, 30814);
		if (!ip.length) {
			toastr.error(vm.i18nDirect.serverIpInvalid, vm.i18nDirect.error, { timeOut: 3500, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		document.getElementById('directip').value = ip;
		document.getElementById('directport').value = String(port);
		vm.directConnect();
	};
	vm.beginEditSavedServer = function(s) {
		if (!s || !s.id)
			return;
		vm.savedServerEditId = String(s.id);
		vm.savedServerEditForm = {
			displayName: String(s.displayName || s.name || ''),
			serverIp: String(s.serverIp || ''),
			port: parsePort(s.port, 30814)
		};
	};
	vm.cancelEditSavedServer = function() {
		vm.savedServerEditId = '';
		vm.savedServerEditForm = { displayName: '', serverIp: '', port: 30814 };
	};
	vm.isEditingSavedServer = function(s) {
		return !!(s && s.id) && String(vm.savedServerEditId || '') === String(s.id);
	};
	vm.saveEditedSavedServer = function(s) {
		if (!s || !s.id)
			return;
		var ip = String(vm.savedServerEditForm.serverIp || '').trim();
		var port = parsePort(vm.savedServerEditForm.port, 0);
		if (!ip.length) {
			toastr.error(vm.i18nDirect.ipRequired, vm.i18nDirect.error, { timeOut: 3500, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		if (port < 1 || port > 65535) {
			toastr.error(vm.i18nDirect.portInvalid, vm.i18nDirect.error, { timeOut: 3500, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		var displayName = String(vm.savedServerEditForm.displayName || '').trim();
		var payload = {
			id: s.id,
			kind: 'savedServer',
			displayName: displayName,
			name: displayName,
			serverIp: ip,
			port: port
		};
		bngApi.engineLua('MPCoreNetwork.roomHostSave(' + bngApi.serializeToLua(JSON.stringify(payload)) + ')');
	};

	vm.joinGuestRoom = function(r) {
		if (!r || !r.id)
			return;
		if (vm.guestStopPending) {
			toastr.info(vm.i18nDirect.waitLeaving, vm.i18nDirect.info, { timeOut: 2000, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		if (vm.hostRunning) {
			toastr.error(vm.i18nDirect.stopHostFirst, vm.i18nDirect.error, { timeOut: 3500, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('GUEST_JOIN:' + r.id) + ')');
	};
	vm.leaveGuestRoom = function() {
		if (vm.guestStopPending)
			return;
		vm.guestStopPending = true;
		vm.guestEtInfoInFlight = false;
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('GUEST_STOP') + ')');
		// 兜底：若 ACK 丢失，主动轮询 LIST 并重发一次 STOP，避免 UI 卡死在“退出中”.
		$timeout(function() {
			if (vm.guestStopPending)
				refreshSavedConfigs();
		}, 400);
		$timeout(function() {
			if (vm.guestStopPending)
				bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('GUEST_STOP') + ')');
		}, 1500);
		$timeout(function() {
			if (vm.guestStopPending)
				refreshSavedConfigs();
		}, 2200);
	};
	vm.isGuestRoomJoined = function(r) {
		return !!(r && r.id) && String(vm.joinedGuestRoomId || '') === String(r.id);
	};
	vm.toggleGuestRoomJoin = function(r) {
		if (!r || !r.id)
			return;
		if (vm.guestStopPending) {
			toastr.info(vm.i18nDirect.waitLeaving, vm.i18nDirect.info, { timeOut: 2000, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		if (vm.isGuestRoomJoined(r))
			vm.leaveGuestRoom();
		else if (vm.joinedGuestRoomId)
			toastr.error(vm.i18nDirect.leaveCurrentRoomFirst, vm.i18nDirect.error, { timeOut: 3500, closeButton: true, positionClass: 'toast-top-center' });
		else
			vm.joinGuestRoom(r);
	};
	vm.requestGuestEtInfo = function(r) {
		if (vm.guestStopPending)
			return;
		var rid = '';
		if (r && r.id)
			rid = String(r.id);
		else if (vm.joinedGuestRoomId)
			rid = String(vm.joinedGuestRoomId);
		if (!rid || String(vm.joinedGuestRoomId || '') !== rid)
			return;
		var now = Date.now();
		if (vm.guestEtInfoInFlight && (now - guestEtInfoLastReqMs) < 2500)
			return;
		vm.guestEtInfoInFlight = true;
		guestEtInfoLastReqMs = now;
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('ETINFO:GUEST') + ')');
	};
	vm.getGuestEtInfo = function(r) {
		if (!r || !r.id)
			return null;
		return vm.guestEtInfoByRoomId[String(r.id)] || null;
	};
	vm.getGuestServerInfo = function(r) {
		if (!r || !r.id)
			return null;
		return vm.guestServerInfoByRoomId[String(r.id)] || null;
	};
	vm.enterGuestRoom = function(r) {
		if (!r || !r.id)
			return;
		if (vm.guestStopPending) {
			toastr.info(vm.i18nDirect.waitLeaving, vm.i18nDirect.info, { timeOut: 2000, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('GUEST_ENTER:' + r.id) + ')');
	};

	vm.deleteSavedConfig = function(id) {
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('DELETE:' + id) + ')');
		$timeout(refreshSavedConfigs, 300);
	};

	var offRoomHost = $scope.$on('roomHostResult', function(event, data) {
		if (!data)
			return;
		if (data.error) {
			vm.guestEtInfoInFlight = false;
			var raw = data.error;
			var silentErrors = ['host room not running', 'remote multiplayer not enabled', 'guest room not joined'];
			if (silentErrors.indexOf(raw) !== -1)
				return;
			var msg = raw;
			if (msg === 'host is offline')
				msg = vm.i18nDirect.hostOffline;
			if (msg === 'guest network start failed; please stop your host room server first')
				msg = vm.i18nDirect.guestStartFailed;
			if (msg === 'peer check timeout')
				msg = vm.i18nDirect.timeout;
			if (msg === 'please join room first')
				msg = vm.i18nDirect.joinRoomFirst;
			if (msg === 'please leave current room first')
				msg = vm.i18nDirect.leaveCurrentRoomFirst;
			if (msg === 'please leave current guest room before editing room configs')
				msg = vm.i18nDirect.leaveCurrentRoomFirst;
			if (msg === 'stop the room server before editing room configs')
				msg = vm.i18nDirect.stopServiceBeforeEdit;
			if (msg === 'stop the running room before editing')
				msg = vm.i18nDirect.roomRunningStopBeforeEdit;
			if (msg === 'leave the joined room before editing')
				msg = vm.i18nDirect.leaveBeforeEdit;
			if (msg === 'please stop room service first')
				msg = vm.i18nDirect.stopHostFirst;
			if (msg === 'please leave room first')
				msg = vm.i18nDirect.leaveRoomFirst;
			if (msg === 'stop the room before delete')
				msg = vm.i18nDirect.stopBeforeDelete;
			if (msg === 'leave the room before delete')
				msg = vm.i18nDirect.leaveBeforeDelete;
			if (raw.indexOf('server is full') === 0) {
				var m = raw.match(/\((\d+)\/(\d+)\)/);
				msg = m ? (vm.i18nDirect.serverFull + ' (' + m[1] + '/' + m[2] + ')') : vm.i18nDirect.serverFull;
			}
			toastr.error(msg, vm.i18nDirect.error, { timeOut: 5000, closeButton: true, positionClass: 'toast-top-center' });
		}
		if (data.running !== undefined)
			vm.hostRunning = !!data.running;
		if (Array.isArray(data.rooms)) {
			var rooms = [];
			var servers = [];
			angular.forEach(data.rooms, function(item) {
				if (!item || typeof item !== 'object')
					return;
				if (item.kind === 'savedServer')
					servers.push(item);
				else if (item.kind === 'guestRoom')
					rooms.push(item);
			});
			vm.guestRooms = rooms;
			vm.savedServers = servers;
		}
		if (data.ok && data.saved && data.room && data.room.kind === 'savedServer') {
			vm.cancelEditSavedServer();
			refreshSavedConfigs();
		}
		if (data.guestJoinedRoomId !== undefined) {
			vm.joinedGuestRoomId = data.guestJoinedRoomId || '';
			vm.guestEtInfoInFlight = false;
			if (!vm.joinedGuestRoomId) {
				vm.guestStopPending = false;
				vm.guestEtInfoByRoomId = {};
				vm.guestServerInfoByRoomId = {};
			}
		}
		if (data.guestJoined) {
			vm.guestStopPending = false;
			toastr.success(vm.i18nDirect.joinedGuest, vm.i18nDirect.info, { timeOut: 2500, closeButton: true, positionClass: 'toast-top-center' });
		}
		if (data.guestStopped) {
			vm.guestStopPending = false;
			toastr.info(vm.i18nDirect.leftGuest, vm.i18nDirect.info, { timeOut: 2500, closeButton: true, positionClass: 'toast-top-center' });
			refreshSavedConfigs();
		}
		if (data.etInfo && data.etInfo.scope === 'guest') {
			vm.guestEtInfoInFlight = false;
			var normalized = beammpNormalizeEtInfo(data.etInfo);
			if (normalized && normalized.roomId) {
				vm.guestEtInfoByRoomId[String(normalized.roomId)] = normalized;
				if (normalized.serverInfo && typeof normalized.serverInfo === 'object') {
					var si = normalized.serverInfo;
					vm.guestServerInfoByRoomId[String(normalized.roomId)] = {
						name: si.sname || si.name || si.server_name || '',
						map: si.map || si.level || '',
						players: si.players || si.clients || si.playerCount || '',
						maxPlayers: si.maxplayers || si.maxPlayers || si.max_clients || '',
						description: si.description || si.desc || '',
						version: si.version || '',
						raw: si.raw || '',
						hostIp: normalized.serverHostIp || '',
						hostPort: normalized.serverHostPort || ''
					};
				}
			}
		}
		if (data.guestEnter && data.guestEnter.ip) {
			var p = parsePort(data.guestEnter.port, 30814);
			var n = data.guestEnter.name || 'Remote Room';
			document.getElementById('LoadingServer').style.display = 'flex';
			bngApi.engineLua('MPCoreNetwork.connectToServer('
				+ bngApi.serializeToLua(data.guestEnter.ip) + ','
				+ p + ','
				+ bngApi.serializeToLua(n) + ', true)');
		}
		$scope.$applyAsync();
	});

	var etGuestTick = $interval(function() {
		if (vm.joinedGuestRoomId && !vm.guestStopPending)
			vm.requestGuestEtInfo();
	}, 2000);

	vm.stateName = $state.current.name;
	bngApi.engineLua('settings.requestState()');
	$scope.$on('$stateChangeSuccess', function (event, toState, toParams, fromState, fromParams) {
		vm.stateName = toState.name;
		if (toState.name === 'menu.multiplayer.direct')
			refreshSavedConfigs();
	});

	/** True on LAN room list / create / edit — used for sidebar highlight (avoid broad indexOf on state names). */
	vm.isRoomSection = function() {
		var n = vm.stateName || '';
		return n === 'menu.multiplayer.rooms' || n === 'menu.multiplayer.roomCreate' || n === 'menu.multiplayer.roomEdit';
	};

	vm.pasteClipboardToDirectIP = function() {
		bngApi.engineLua('getClipboard()', function (str) {
			$scope.$evalAsync(() =>  {
				if(!str.includes('.')) return;

				var split = str.split(':');

				document.getElementById('directip').value = split[0];
				if (split.length==2) document.getElementById('directport').value = split[1];
			});
		});

	};

	vm.downloadingMods = [];
	vm.loadingStatus = "";
	var lastModInfo = '';

	$scope.$on('LoadingInfo', function (event, data) {
		//console.log(vm, event, data)
		const loadingStatusElement = document.getElementById('LoadingStatus')
		//console.log(data.message)

		// Split the message into parts: mod number, mod name, progress, speed
		let modNumber = null;
		let modName = null;
		let progress = null;
		let speed = null;

		if (data.message.startsWith("Downloading Resource")) {
			let modlist = document.getElementById('mod-download-list');
			if (modlist) {
				modlist.style.display = 'block';
			}
			// Sample: 'Downloading Resource 1/10: Nissan 350z.zip (1.0%) at 12.8 Mbit/s'
			// Extract mod number, name, progress, and speed from the message
			const regex = /Downloading Resource (\d+\/\d+): (.+?) \((\d+\.\d+)%\)(?: at (.+))?/;
			const matches = data.message.match(regex);
			if (matches) {
				modNumber = matches[1];
				modName = matches[2];
				progress = matches[3];
				speed = matches[4] || '...';
			}
			//console.log(`Mod ${modNumber}: ${modName} - ${progress}% at ${speed}`);

			// Update current downloading mod info and if complete then push this mod into the downloaded mods info
			$scope.$apply(function() {
				// Update or add the current mod being downloaded
				const existingMod = vm.downloadingMods.find(mod => mod.name === modName);
				if (existingMod) {
					existingMod.progress = progress;
					existingMod.speed = speed;
				} else {
					// add this new mod to the beginning of the array
					vm.downloadingMods = [{ number: modNumber, name: modName, progress: progress, speed: speed }, ...vm.downloadingMods];
				}

				// If we switched to a new mod, mark the last one as done
				if (lastModInfo != '' && lastModInfo != modName) {
					const lastMod = vm.downloadingMods.find(mod => mod.name === lastModInfo);
					lastMod.progress = 100;
					lastMod.speed = $filter('translate')('ui.multiplayer.download.done');
					lastModInfo = modName;
				}
			});
		} else if (data.message.startsWith("Loading Resource")) {
			let modlist = document.getElementById('mod-download-list');
			if (modlist) {
				modlist.style.display = 'block';
			}
			// Sample: 'Loading Resource 1/70: Scintillacamaf.zip'
			const regex = /Loading Resource (\d+\/\d+): (.+)/;
			const matches = data.message.match(regex);
			if (matches) {
				modNumber = matches[1];
				modName = matches[2];
			}
			//console.log(`Mod ${modNumber}: ${modName} - Loading`);

			// Update current downloading mod info and if complete then push this mod into the downloaded mods info
			$scope.$apply(function() {
				// Update or add the current mod being downloaded
				const existingMod = vm.downloadingMods.find(mod => mod.name === modName);
				if (existingMod) {
					existingMod.progress = '100';
					existingMod.speed = $filter('translate')('ui.multiplayer.loading');
				} else {
					vm.downloadingMods = [{ number: modNumber, name: modName, progress: '100', speed: $filter('translate')('ui.multiplayer.loading') }, ...vm.downloadingMods];
				}
			});
		} else {
			if (data.message == "done") {
				vm.loadingStatus = $filter('translate')('ui.multiplayer.download.done');
				lastModInfo = '';
			} else {
				vm.loadingStatus = data.message;
			}

			document.getElementById('LoadingStatus').innerText = vm.loadingStatus;

			vm.downloadingMods = []
		
			document.getElementById('OriginalLoadingStatus').setAttribute("hidden", "hidden");
			loadingStatusElement.removeAttribute("hidden");
		}
		let divider = document.getElementById('loadingstatus-divider')
		if (divider) {
			divider.style.display = (vm.downloadingMods.length > 0 || vm.loadingStatus != "") ? "block" : "none";
		}

		$scope.$applyAsync();
	});


	$scope.$on('authReceived', function (event, data) {
		let nameElement = document.getElementById("serverlist-profile-name")
		let idElement = document.getElementById("serverlist-profile-id")

		if (Object.keys(data).length > 1) {
			if (data.color != null)
				nameElement.style.backgroundColor = data.color
			else
				nameElement.style.backgroundColor = "rgba(0, 0, 0, 0)"

			nameElement.textContent = data.username;

			if (data.id != null) {
				nameElement.style.cursor = "default";
				nameElement.onclick = null;

				idElement.textContent = "ID: " + data.id
				idElement.onclick = function () {
					bngApi.engineLua(`setClipboard("` + data.id + `")`);
					toastr.info(vm.i18nDirect.copiedId, vm.i18nDirect.info, { timeOut: 2500, closeButton: true, positionClass: 'toast-top-center' });
				}
				if (data.role != "USER") {
					idElement.style.marginTop = "0"
				} else {
					idElement.style.marginTop = "6px"
				}
			} else {
				idElement.textContent = "";
				nameElement.onclick = null;
				nameElement.style.cursor = "default";
			}
		} else {
			nameElement.textContent = "";
			nameElement.style.backgroundColor = "rgba(0, 0, 0, 0)";
			idElement.textContent = "";
		}
	});

	vm.exit = function ($event) {
		if ($event)
		console.log('[MultiplayerController] exiting by keypress event %o', $event);
		$state.go('menu.mainmenu');
	};

	var timeOut = $timeout(function() {
		if (vm.loadingPage === true) {
			vm.loadTimeout = true;
		}
	}, 10000);

	$scope.$on('$destroy', function () {
		$timeout.cancel(timeOut);
		offRoomHost();
		$interval.cancel(etGuestTick);
		//console.log('[MultiplayerController] destroyed.');
	});
}])

/* //////////////////////////////////////////////////////////////////////////////////////////////
*	SERVERS TAB
*/ //////////////////////////////////////////////////////////////////////////////////////////////
.controller('MultiplayerServersController', ['$scope', '$state', '$timeout', '$filter',
function($scope, $state, $timeout, $filter) {

	var vm = this;
	let serverListOptions = JSON.parse(localStorage.getItem("serverListOptions"))

	if (serverListOptions != null && serverListOptions.serverVersions != null && serverListOptions.tags != null && serverListOptions.serverLocations != null) {
		vm.checkIsEmpty = serverListOptions.checkIsEmpty
		vm.checkIsNotEmpty = serverListOptions.checkIsNotEmpty
		vm.checkIsNotFull = serverListOptions.checkIsNotFull
		vm.checkModSlider = serverListOptions.checkModSlider
		vm.sliderMaxModSize = serverListOptions.sliderMaxModSize
		vm.selectMap = serverListOptions.selectMap
		vm.serverVersions = serverListOptions.serverVersions
		vm.tags = serverListOptions.tags
		vm.serverLocations = serverListOptions.serverLocations
		vm.searchText = ""
	} else {
		vm.checkIsEmpty = false
		vm.checkIsNotEmpty = false
		vm.checkIsNotFull = false
		vm.checkModSlider = false
		vm.sliderMaxModSize = 500 // in MB
		vm.selectMap = "Any map"
		vm.serverVersions = []
		vm.tags = []
		vm.serverLocations = []
		vm.searchText = ""
	}


	bngApi.engineLua('MPCoreNetwork.requestServerList()');

	// Go back to the main menu on exit
	vm.exit = function ($event) {
		if ($event) console.log('[MultiplayerServersController] exiting by keypress event %o', $event);
		$state.go('menu.mainmenu');
	};

	const serversTableContainer = document.getElementById("serversTableContainer");
	$scope.itemHeight = 24;
	$scope.buffer = 10;
	$scope.viewportHeight = serversTableContainer.clientHeight;
	$scope.selectedServerId = null;
	$scope.expandedRowHeight = 0;
	$scope.loadingShimmerCount = Math.ceil($scope.viewportHeight / $scope.itemHeight)

	$scope.onScroll = function() {
		const scrollTop = serversTableContainer.scrollTop;
		const total = $scope.serversArray.length;
		const itemHeight = $scope.itemHeight;
		const viewportHeight = $scope.viewportHeight;
		const buffer = $scope.buffer;
		
		const itemsPerView = Math.ceil(viewportHeight / itemHeight);
		const scrollRow = Math.floor(scrollTop / itemHeight);
		
		let startIndex = Math.max(0, scrollRow - Math.ceil(itemsPerView) + buffer);
		let endIndex = Math.min(total, scrollRow + Math.ceil(itemsPerView) + buffer);
		
		let beforeHeight = startIndex * itemHeight;
		let afterHeight = (total - endIndex) * itemHeight;

		if ($scope.selectedServerId && $scope.selectedIndex !== -1) {
			const selectedServerExists = $scope.serversArray.some(s => s.id === $scope.selectedServerId);
			if (selectedServerExists) {
				// when selectedIndex is not in the view anymore
				if ($scope.selectedIndex < startIndex || $scope.selectedIndex >= endIndex) {
					//if the selected server is above the current view
					if ($scope.selectedIndex < scrollRow) {		//this compense the height of the expanded row that is not rendered anymore
						beforeHeight += $scope.expandedRowHeight;
					}else{	//if the selected server is below the current view
						afterHeight += $scope.expandedRowHeight;
					}
				}
			}
		}

		$scope.visibleServers = $scope.serversArray.slice(startIndex, endIndex);
		$scope.beforeHeight = beforeHeight;
		$scope.afterHeight = afterHeight;
		if (!$scope.$$phase) $scope.$digest();
	};

	$scope.selectServer = function(server) {
		const serverId = server.id;
		highlightedServer = server.server
		if ($scope.selectedServerId === serverId) {
			$scope.selectedServerId = null;
			highlightedServer = null
			$scope.expandedRowHeight = 0;
		} else {
			$scope.selectedServerId = serverId;
			$scope.selectedIndex = $scope.serversArray.findIndex(s => s.id === $scope.selectedServerId);

			$timeout(function() {	//timeout because the serverInfoRow is not rendered yet
				const row = document.getElementById('ServerInfoRow');
				$scope.expandedRowHeight = row.offsetHeight;
			})
		}
		$scope.onScroll();
	};

	serversTableContainer.addEventListener('scroll', () => {
		$scope.onScroll();
	}, { passive: true });



	$scope.sortTable = function(sortType, isNumber, dir) {
		const direction = dir || $scope.sortDirection || 1;
		$scope.sortDirection = -direction; // toggle direction

		$scope.serversArray.sort((a, b) => {
			const aVal = a.server[sortType];
			const bVal = b.server[sortType];
			if (isNumber) {
			return direction * (Number(aVal) - Number(bVal));
			} else {
			return direction * aVal.toString().localeCompare(bVal.toString(), undefined, { numeric: true });
			}
		});

		$scope.onScroll();
	}

	$scope.listPlayers = listPlayers;
	$scope.formatCodes = formatCodes;
	$scope.SmoothMapName = SmoothMapName;
	$scope.modCount = modCount;
	$scope.modList = modList;
	$scope.formatBytes = formatBytes;
	$scope.connect = connect;
	// Page loading timeout
	var timeOut = $timeout(function () {
		if (vm.loadingPage === true) {
			vm.loadTimeout = true;
		}
	}, 10000);

	// Called when the page is left
	$scope.$on('$destroy', function () {
		serverView = "all";
		$timeout.cancel(timeOut);
		//console.log('[MultiplayerServersController] destroyed.');
		var buttons = document.getElementsByClassName("servers-btn");
		for (var i = 0; i < buttons.length; i++) {
			buttons[i].classList.remove("md-primary");
			buttons[i].classList.remove("md-raised");
		}
	});
	
	$scope.$on('onServerListReceived', async function (event, data) {
		
		servers = await receiveServers(data);

		vm.availableServerVersions = [];
		vm.availableMaps = [];
		vm.availableTags = [];
		vm.availableServerLocations = [];

		for (const server of servers) {
			if (!vm.availableServerVersions.includes("v" + server.version)) vm.availableServerVersions.push("v" + server.version);

			if (!vm.availableServerLocations.includes(server.location)) vm.availableServerLocations.push(server.location);

			var smoothMapName = SmoothMapName(server.map);

			if(!vm.availableMaps.includes(smoothMapName)) vm.availableMaps.push(smoothMapName);

			var serverTags = server.tags.split(",");
			for (const tag of serverTags) {
				if (!vm.availableTags.includes(tag.trim())) vm.availableTags.push(tag.trim());	
			}
		}

		
		vm.availableMaps.sort();
		vm.availableMaps.unshift("Any map");

		vm.availableServerVersions.sort();

		vm.availableServerLocations.sort();
		
		vm.availableTags.sort();

		vm.repopulate();
	});

	vm.repopulate = async function () {
		if (serverListOptions != null) {
			if (serverListOptions.checkIsEmpty && vm.checkIsNotEmpty) vm.checkIsEmpty = false;
			if (serverListOptions.checkIsNotEmpty && vm.checkIsEmpty) vm.checkIsNotEmpty = false;
		}


		await populateTable(
			$filter,
			$scope,
			servers,
			serverView,
			vm.searchText,
			vm.checkIsEmpty,
			vm.checkIsNotEmpty,
			vm.checkIsNotFull,
			vm.checkModSlider,
			vm.sliderMaxModSize,
			vm.selectMap,
			vm.serverVersions,
			vm.tags,
			vm.serverLocations		
		);

		serverListOptions = {
			checkIsEmpty: vm.checkIsEmpty,
			checkIsNotEmpty: vm.checkIsNotEmpty,
			checkIsNotFull: vm.checkIsNotFull,
			checkModSlider: vm.checkModSlider,
			sliderMaxModSize: vm.sliderMaxModSize,
			selectMap: vm.selectMap,
			serverVersions: vm.serverVersions,
			serverLocations: vm.serverLocations,
			tags: vm.tags
		};

		var activeFiltersText = "";
		if (vm.checkIsEmpty) activeFiltersText += $filter('translate')('ui.multiplayer.filters.empty') + ", ";
		if (vm.checkIsNotEmpty) activeFiltersText += $filter('translate')('ui.multiplayer.filters.notEmpty') + ", ";
		if (vm.checkIsNotFull) activeFiltersText += $filter('translate')('ui.multiplayer.filters.notFull') + ", ";
		if (vm.checkModSlider) activeFiltersText += $filter('translate')('ui.multiplayer.filters.modSize') + " < " + vm.sliderMaxModSize + "MB, ";
		if (vm.selectMap != "Any map") activeFiltersText += $filter('translate')('ui.multiplayer.filters.map') + ": " + vm.selectMap + ", ";
		if (vm.serverVersions.length > 0) activeFiltersText += $filter('translate')('ui.multiplayer.filters.serverVersions') + vm.serverVersions.join(", ") + ", ";
		if (vm.tags.length > 0) activeFiltersText += $filter('translate')('ui.multiplayer.filters.tags') + vm.tags.join(", ") + ", ";
		if (vm.serverLocations.length > 0) activeFiltersText += $filter('translate')('ui.multiplayer.filters.serverLocations') + vm.serverLocations.join(", ") + ", ";

		var clearFiltersButton = document.getElementById("clearFiltersButton");
		//var FiltersPrefix = document.getElementById("FiltersPrefix");

		if (activeFiltersText.length > 0) { 
			activeFiltersText = activeFiltersText.slice(0, -2);
			clearFiltersButton.style.display = "block"; 
			//FiltersPrefix.style.display = "block";
		} else {
			clearFiltersButton.style.display = "none";
			//FiltersPrefix.style.display = "none";
		}

		document.getElementById("activeFilters").innerText = activeFiltersText

		localStorage.setItem("serverListOptions", JSON.stringify(serverListOptions));
	};


	$scope.isFilterOverlayVisible = false;

	$scope.toggleFilterOverlay = function () {
		$scope.isFilterOverlayVisible = !$scope.isFilterOverlayVisible;
	};

	$scope.clearFilters = function () {
		vm.checkIsEmpty = false;
		vm.checkIsNotEmpty = false;
		vm.checkIsNotFull = false;
		vm.checkModSlider = false;
		vm.sliderMaxModSize = 500;
		vm.selectMap = "Any map";
		vm.serverVersions = [];
		vm.tags = [];
		vm.serverLocations = [];
		vm.repopulate();
	}

	repopulateServerList = function () { vm.repopulate().then(() => { }); }
}])

/* //////////////////////////////////////////////////////////////////////////////////////////////
*	DIRECT CONNECT TAB
*/ //////////////////////////////////////////////////////////////////////////////////////////////
.controller('MultiplayerDirectController', ['$scope', '$state', '$timeout',
function($scope, $state, $timeout) {
	var vm = this;

	var timeOut = $timeout(function() {
		if (vm.loadingPage === true) {
			vm.loadTimeout = true;
		}
	}, 10000);

	vm.exit = function ($event) {
		if ($event)
		console.log('[MultiplayerDirectController] exiting by keypress event %o', $event);
		$state.go('menu.mainmenu');
	};

	$scope.$on('$destroy', function () {
		$timeout.cancel(timeOut);
		//console.log('[MultiplayerDirectController] destroyed.');
	});
}])

.controller('MultiplayerRoomsController', ['$scope', '$rootScope', '$interval', '$state', '$translate', '$timeout', 'toastr',
function($scope, $rootScope, $interval, $state, $translate, $timeout, toastr) {
	var vm = this;
	vm.rooms = [];
	vm.running = false;
	vm.activeRoomId = '';
	vm.guestJoinedRoomId = '';
	vm.hostStopPending = false;
	vm.hostEtInfoByRoomId = {};
	vm.hostEtInfoInFlight = false;
	var hostEtInfoLastReqMs = 0;
	vm.pendingDeleteId = '';
	var pendingDeleteTimer = null;

	vm.confirmDelete = function(id) {
		if (vm.pendingDeleteId === id) {
			vm.pendingDeleteId = '';
			if (pendingDeleteTimer) { $timeout.cancel(pendingDeleteTimer); pendingDeleteTimer = null; }
			vm.deleteRoom(id);
			return;
		}
		vm.pendingDeleteId = id;
		if (pendingDeleteTimer) $timeout.cancel(pendingDeleteTimer);
		pendingDeleteTimer = $timeout(function() { vm.pendingDeleteId = ''; }, 3000);
	};

	function applyRoomListUiStrings() {
		var ui = {};
		angular.forEach(BEAMMP_ROOM_LIST_KEYS, function(trKey, prop) {
			ui[prop] = beammpRoomTranslate($translate, trKey, BEAMMP_ROOM_LIST_FB[prop]);
		});
		vm.ui = ui;
		vm.i18n = {
			title: beammpLocaleText($translate, { zh: '房主模式', zhHant: '房主模式', en: 'Host Mode' }),
			hint: beammpLocaleText($translate, { zh: '创建离线房间配置。本机点击「进入」连 127.0.0.1；其他玩家通过局域网IP或房间名称&密码加入。', zhHant: '建立離線房間設定。本機按「進入」連 127.0.0.1；其他玩家可透過區域網 IP 或房間名稱&密碼加入。', en: 'Create offline room configs. This PC joins via 127.0.0.1; others join via LAN IP or room name & password.' }),
			create: beammpLocaleText($translate, { zh: '创建房间', zhHant: '建立房間', en: 'Create Room' }),
			empty: beammpLocaleText($translate, { zh: '暂无已保存的房间。', zhHant: '暫無已儲存的房間。', en: 'No saved rooms.' }),
			port: beammpLocaleText($translate, { zh: '端口', zhHant: '連接埠', en: 'Port' }),
			start: beammpLocaleText($translate, { zh: '启动服务', zhHant: '啟動服務', en: 'Start Service' }),
			stop: beammpLocaleText($translate, { zh: '停止服务', zhHant: '停止服務', en: 'Stop Service' }),
			edit: beammpLocaleText($translate, { zh: '编辑', zhHant: '編輯', en: 'Edit' }),
			join: beammpLocaleText($translate, { zh: '进入', zhHant: '進入', en: 'Join' }),
			delete: beammpLocaleText($translate, { zh: '删除', zhHant: '刪除', en: 'Delete' }),
			confirmDelete: beammpLocaleText($translate, { zh: '确认删除', zhHant: '確認刪除', en: 'Confirm Delete' }),
			remoteNodeInfo: beammpLocaleText($translate, { zh: '远程联机节点信息', zhHant: '遠端連線節點資訊', en: 'Remote Node Info' }),
			session: beammpLocaleText($translate, { zh: '会话', zhHant: '會話', en: 'Session' }),
			room: beammpLocaleText($translate, { zh: '房间', zhHant: '房間', en: 'Room' }),
			nodeCount: beammpLocaleText($translate, { zh: '节点数', zhHant: '節點數', en: 'Nodes' }),
			virtualIpv4: beammpLocaleText($translate, { zh: '虚拟IPv4', zhHant: '虛擬IPv4', en: 'Virtual IPv4' }),
			hostname: beammpLocaleText($translate, { zh: '主机名', zhHant: '主機名', en: 'Hostname' }),
			route: beammpLocaleText($translate, { zh: '路由', zhHant: '路由', en: 'Route' }),
			protocol: beammpLocaleText($translate, { zh: '协议', zhHant: '協議', en: 'Protocol' }),
			latency: beammpLocaleText($translate, { zh: '延迟', zhHant: '延遲', en: 'Latency' }),
			upload: beammpLocaleText($translate, { zh: '上传', zhHant: '上傳', en: 'Upload' }),
			download: beammpLocaleText($translate, { zh: '下载', zhHant: '下載', en: 'Download' }),
			loss: beammpLocaleText($translate, { zh: '丢包率', zhHant: '丟包率', en: 'Loss' }),
			natType: beammpLocaleText($translate, { zh: 'NAT类型', zhHant: 'NAT類型', en: 'NAT Type' }),
			version: beammpLocaleText($translate, { zh: '版本', zhHant: '版本', en: 'Version' }),
			noNodeData: beammpLocaleText($translate, { zh: '暂无节点数据（展开时自动刷新）', zhHant: '暫無節點資料（展開時自動刷新）', en: 'No node data (auto refresh on expand)' }),
			error: beammpLocaleText($translate, { zh: '错误', zhHant: '錯誤', en: 'Error' }),
			info: beammpLocaleText($translate, { zh: '提示', zhHant: '提示', en: 'Info' }),
			waitStop: beammpLocaleText($translate, { zh: '正在停止服务，请稍候', zhHant: '正在停止服務，請稍候', en: 'Stopping service, please wait' }),
			leaveRoomFirst: beammpLocaleText($translate, { zh: '请先退出房间', zhHant: '請先退出房間', en: 'Please leave room first' }),
			stopServiceFirst: beammpLocaleText($translate, { zh: '请先关闭房间服务', zhHant: '請先關閉房間服務', en: 'Please stop room service first' }),
			roomRunningStopBeforeEdit: beammpLocaleText($translate, { zh: '该房间正在运行，请先停止服务再编辑', zhHant: '該房間正在運行，請先停止服務再編輯', en: 'Room is running. Stop service before editing.' }),
			roomNameOrPwdConflict: beammpLocaleText($translate, { zh: '房间名或密码与其他用户重复', zhHant: '房間名或密碼與其他使用者重複', en: 'Room name or password conflicts with another user' }),
			timeout: beammpLocaleText($translate, { zh: '检测超时', zhHant: '檢測逾時', en: 'Check timed out' }),
			stopBeforeEdit: beammpLocaleText($translate, { zh: '请先停止服务', zhHant: '請先停止服務', en: 'Please stop service first' }),
			leaveBeforeEdit: beammpLocaleText($translate, { zh: '该房间正在连接中，请先退出再编辑', zhHant: '該房間連線中，請先退出再編輯', en: 'Room is connected. Leave before editing.' }),
			stopBeforeDelete: beammpLocaleText($translate, { zh: '请先停止服务再删除', zhHant: '請先停止服務再刪除', en: 'Stop service before deleting' }),
			leaveBeforeDelete: beammpLocaleText($translate, { zh: '请先退出房间再删除', zhHant: '請先退出房間再刪除', en: 'Leave room before deleting' })
		};
	}
	applyRoomListUiStrings();
	$scope.$on('$translateChangeSuccess', applyRoomListUiStrings);
	if (typeof $translate.onReady === 'function') {
		$translate.onReady(function() {
			applyRoomListUiStrings();
			$scope.$evalAsync();
		});
	}
	$timeout(applyRoomListUiStrings, 0);
	$timeout(applyRoomListUiStrings, 400);

	function forceHash(path) {
		if (!path)
			return;
		var useBang = (window.location.hash || '').indexOf('#!/') === 0;
		window.location.hash = (useBang ? '#!' : '#') + path;
	}

	function goStateWithFallback(stateName, params, fallbackPath, $event) {
		if ($event) {
			$event.preventDefault();
			$event.stopPropagation();
		}
		$timeout(function() {
			var p;
			try {
				p = $state.go(stateName, params || {});
			} catch (e) {
				forceHash(fallbackPath);
				return;
			}
			if (p && typeof p.catch === 'function') {
				p.catch(function() {
					forceHash(fallbackPath);
				});
			}
			$timeout(function() {
				if ($state.current && $state.current.name === 'menu.multiplayer.rooms')
					forceHash(fallbackPath);
			}, 120);
		}, 0);
	}

	/** 双保险：$state.go + hash 兜底（CEF 某些层会吞路由点击） */
	vm.goCreate = function($event) {
		goStateWithFallback('menu.multiplayer.roomCreate', {}, '/menu/multiplayer/mproomcreate', $event);
	};
	vm.goEdit = function(id, $event) {
		if (vm.running && String(vm.activeRoomId) === String(id)) {
			toastr.error(vm.i18n.roomRunningStopBeforeEdit, vm.i18n.error, { timeOut: 3500, closeButton: true, positionClass: 'toast-top-center' });
			if ($event) {
				$event.preventDefault();
				$event.stopPropagation();
			}
			return;
		}
		goStateWithFallback('menu.multiplayer.roomEdit', { roomId: id }, '/menu/multiplayer/mproomedit/' + encodeURIComponent(id), $event);
	};

	vm.refresh = function() {
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('LIST') + ')');
	};

	vm.isRoomRunning = function(id) {
		return vm.running && String(vm.activeRoomId) === String(id);
	};

	vm.canJoin = function(r) {
		return vm.running && String(vm.activeRoomId) === String(r.id);
	};

	vm.startRoom = function(id) {
		if (vm.hostStopPending) {
			toastr.info(vm.i18n.waitStop, vm.i18n.info, { timeOut: 2200, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		if (vm.guestJoinedRoomId) {
			toastr.error(vm.i18n.leaveRoomFirst, vm.i18n.error, { timeOut: 3500, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		if (vm.running && String(vm.activeRoomId || '') !== String(id || '')) {
			toastr.error(vm.i18n.stopServiceFirst, vm.i18n.error, { timeOut: 3500, closeButton: true, positionClass: 'toast-top-center' });
			return;
		}
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('START:' + id) + ')');
	};

	vm.stopRoom = function() {
		if (vm.hostStopPending)
			return;
		vm.hostStopPending = true;
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('STOP') + ')');
		$timeout(function() {
			if (vm.hostStopPending)
				vm.refresh();
		}, 500);
	};

	vm.deleteRoom = function(id) {
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('DELETE:' + id) + ')');
		$timeout(vm.refresh, 300);
	};

	vm.joinRoom = function(r) {
		var port = parseInt(r.port, 10) || 30814;
		var name = r.displayName || r.name || 'LAN';
		document.getElementById('LoadingServer').style.display = 'flex';
		bngApi.engineLua('MPCoreNetwork.connectToServer("127.0.0.1",' + port + ',' + bngApi.serializeToLua(name) + ', true)');
	};
	vm.requestHostEtInfo = function(r) {
		if (vm.hostStopPending)
			return;
		if (!r || !vm.isRoomRunning(r.id) || !r.remoteMultiplayerEnabled)
			return;
		var now = Date.now();
		if (vm.hostEtInfoInFlight && (now - hostEtInfoLastReqMs) < 2500)
			return;
		vm.hostEtInfoInFlight = true;
		hostEtInfoLastReqMs = now;
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('ETINFO:HOST') + ')');
	};
	vm.getHostEtInfo = function(r) {
		if (!r || !r.id)
			return null;
		return vm.hostEtInfoByRoomId[String(r.id)] || null;
	};

	var off = $rootScope.$on('roomHostResult', function(ev, data) {
		if (!data)
			return;
		if (data.error) {
			vm.hostEtInfoInFlight = false;
			var raw = data.error;
			var silentErrors = ['host room not running', 'remote multiplayer not enabled'];
			if (silentErrors.indexOf(raw) !== -1)
				return;
			var msg = raw;
			if (msg === 'Room name or password conflicts with another user')
				msg = vm.i18n.roomNameOrPwdConflict;
			if (msg === 'peer check timeout')
				msg = vm.i18n.timeout;
			if (msg === 'stop the room server before editing room configs')
				msg = vm.i18n.stopBeforeEdit;
			if (msg === 'stop the running room before editing')
				msg = vm.i18n.roomRunningStopBeforeEdit;
			if (msg === 'leave the joined room before editing')
				msg = vm.i18n.leaveBeforeEdit;
			if (msg === 'please leave room first')
				msg = vm.i18n.leaveRoomFirst;
			if (msg === 'please stop room service first')
				msg = vm.i18n.stopServiceFirst;
			if (msg === 'stop the room before delete')
				msg = vm.i18n.stopBeforeDelete;
			if (msg === 'leave the room before delete')
				msg = vm.i18n.leaveBeforeDelete;
			if (msg)
				toastr.error(msg, vm.i18n.error, { timeOut: 6000, closeButton: true, positionClass: 'toast-top-center' });
		}
		if (data.guestJoinedRoomId !== undefined)
			vm.guestJoinedRoomId = data.guestJoinedRoomId || '';
		if (Array.isArray(data.rooms)) {
			vm.rooms = data.rooms.filter(function(r) {
				if (!r || typeof r !== 'object')
					return false;
				var k = String(r.kind || 'hostRoom').toLowerCase();
				return k !== 'guestroom' && k !== 'savedserver';
			});
			vm.running = !!data.running;
			vm.activeRoomId = data.activeRoomId || '';
			if (!vm.running || !vm.activeRoomId)
				vm.hostEtInfoByRoomId = {};
			if (!vm.running)
				vm.hostStopPending = false;
		}
		if (data.running !== undefined && !Array.isArray(data.rooms)) {
			vm.running = !!data.running;
			if (data.activeRoomId !== undefined)
				vm.activeRoomId = data.activeRoomId || '';
			else if (!vm.running)
				vm.activeRoomId = '';
			if (!vm.running || !vm.activeRoomId)
				vm.hostEtInfoByRoomId = {};
			if (!vm.running)
				vm.hostStopPending = false;
		}
		if (data.etInfo && data.etInfo.scope === 'host') {
			vm.hostEtInfoInFlight = false;
			var normalized = beammpNormalizeEtInfo(data.etInfo);
			if (normalized && normalized.roomId)
				vm.hostEtInfoByRoomId[String(normalized.roomId)] = normalized;
		}
		$scope.$applyAsync();
	});

	var tick = $interval(vm.refresh, 5000);
	var etTick = $interval(function() {
		if (!vm.running || !vm.activeRoomId || vm.hostStopPending)
			return;
		var room = null;
		angular.forEach(vm.rooms, function(x) {
			if (!room && String(x.id) === String(vm.activeRoomId))
				room = x;
		});
		if (room && room.remoteMultiplayerEnabled)
			vm.requestHostEtInfo(room);
	}, 2000);
	vm.refresh();

	$scope.$on('$destroy', function() {
		off();
		$interval.cancel(tick);
		$interval.cancel(etTick);
	});
}])

.controller('MultiplayerRoomFormController', ['$scope', '$rootScope', '$state', '$stateParams', '$timeout', 'toastr', '$translate',
function($scope, $rootScope, $state, $stateParams, $timeout, toastr, $translate) {
	var vm = this;
	var trRoomForm = function(fb) { return beammpLocaleText($translate, fb); };
	vm.isEdit = !!($stateParams && $stateParams.roomId);
	vm.i18n = {
		titleEdit: beammpLocaleText($translate, { zh: '编辑房间', zhHant: '編輯房間', en: 'Edit Room' }),
		titleCreate: beammpLocaleText($translate, { zh: '创建房间', zhHant: '建立房間', en: 'Create Room' }),
		hint: beammpLocaleText($translate, { zh: '带 * 为必填项；未标 * 的字段可留空。', zhHant: '帶 * 為必填項；未標 * 的欄位可留空。', en: 'Fields marked with * are required; others can be left empty.' }),
		displayName: beammpLocaleText($translate, { zh: '房间显示名称 *', zhHant: '房間顯示名稱 *', en: 'Room Display Name *' }),
		serverName: beammpLocaleText($translate, { zh: '服务器名称', zhHant: '伺服器名稱', en: 'Server Name' }),
		serverNamePlaceholder: beammpLocaleText($translate, { zh: '留空自动使用显示名称', zhHant: '留空自動使用顯示名稱', en: 'Leave empty to use display name' }),
		port: beammpLocaleText($translate, { zh: '端口', zhHant: '連接埠', en: 'Port' }),
		maxPlayers: beammpLocaleText($translate, { zh: '最大玩家数', zhHant: '最大玩家數', en: 'Max Players' }),
		maxCars: beammpLocaleText($translate, { zh: '每人最大车辆数', zhHant: '每人最大車輛數', en: 'Max Cars Per Player' }),
		maxCarsHint: beammpLocaleText($translate, { zh: '如果要开启交通流建议设置 100 以上', zhHant: '若要開啟交通流建議設定 100 以上', en: 'For AI traffic, 100+ is recommended.' }),
		map: beammpLocaleText($translate, { zh: '地图', zhHant: '地圖', en: 'Map' }),
		mapSelectPlaceholder: beammpLocaleText($translate, { zh: '-- 请选择地图 --', zhHant: '-- 請選擇地圖 --', en: '-- Select map --' }),
		mapPath: beammpLocaleText($translate, { zh: '地图路径（可手动覆盖）', zhHant: '地圖路徑（可手動覆蓋）', en: 'Map Path (Manual Override)' }),
		description: beammpLocaleText($translate, { zh: '描述', zhHant: '描述', en: 'Description' }),
		tags: beammpLocaleText($translate, { zh: '标签', zhHant: '標籤', en: 'Tags' }),
		tagsPlaceholder: beammpLocaleText($translate, { zh: '使用\",\"分隔', zhHant: '使用\",\"分隔', en: 'Use \",\" as separator' }),
		bindIp: beammpLocaleText($translate, { zh: '绑定 IP（0.0.0.0 = 所有网卡）', zhHant: '綁定 IP（0.0.0.0 = 所有網卡）', en: 'Bind IP (0.0.0.0 = all interfaces)' }),
		debugPanel: beammpLocaleText($translate, { zh: '调试选项', zhHant: '偵錯選項', en: 'Debug Options' }),
		debugMode: beammpLocaleText($translate, { zh: '调试模式（输出更多日志）', zhHant: '偵錯模式（輸出更多日誌）', en: 'Debug Mode (more logs)' }),
		hideUpdates: beammpLocaleText($translate, { zh: '隐藏版本更新提醒', zhHant: '隱藏版本更新提醒', en: 'Hide update reminders' }),
		publicNodes: beammpLocaleText($translate, { zh: '公共节点（访客需要连接到与你相同或可互通的节点，否则将无法发现该房间）', zhHant: '公共節點（訪客需連到與你相同或可互通的節點，否則無法發現該房間）', en: 'Public Nodes (Guests should use same/reachable nodes)' }),
		publicNodesPlaceholder: beammpLocaleText($translate, { zh: '支持\",\"，\";\"分隔，多节点可混填（可省略 tcp://）', zhHant: '支援\",\"、\";\"分隔，多節點可混填（可省略 tcp://）', en: 'Use \",\" or \";\" to separate nodes; tcp:// can be omitted' }),
		advanced: beammpLocaleText($translate, { zh: '高级设置', zhHant: '進階設定', en: 'Advanced Settings' }),
		featureSwitchHint: beammpLocaleText($translate, { zh: '功能开关（对应 easytier-core 命令行参数）', zhHant: '功能開關（對應 easytier-core 命令列參數）', en: 'Feature switches (mapped to easytier-core CLI flags)' }),
		logChat: beammpLocaleText($translate, { zh: '记录聊天', zhHant: '記錄聊天', en: 'Log Chat' }),
		informationPacket: beammpLocaleText($translate, { zh: '信息包', zhHant: '資訊封包', en: 'Information Packet' }),
		save: beammpLocaleText($translate, { zh: '保存', zhHant: '儲存', en: 'Save' }),
		cancel: beammpLocaleText($translate, { zh: '取消 / 返回', zhHant: '取消 / 返回', en: 'Cancel / Back' }),
		needDisplayName: beammpLocaleText($translate, { zh: '请填写房间显示名称', zhHant: '請填寫房間顯示名稱', en: 'Please enter room display name' }),
		saveFailed: beammpLocaleText($translate, { zh: '保存失败', zhHant: '儲存失敗', en: 'Save Failed' }),
		stopRunningBeforeEdit: beammpLocaleText($translate, { zh: '该房间正在运行，请先停止服务再编辑', zhHant: '該房間正在運行，請先停止服務再編輯', en: 'Room is running. Stop service before editing.' }),
		stopServiceFirst: beammpLocaleText($translate, { zh: '请先停止服务', zhHant: '請先停止服務', en: 'Please stop service first' }),
		requirePassword: beammpLocaleText($translate, { zh: '远程联机需要设置房间密码', zhHant: '遠端連線需要設定房間密碼', en: 'Remote multiplayer requires room password' }),
		writeRoomFailed: beammpLocaleText($translate, { zh: '保存房间文件失败', zhHant: '儲存房間檔案失敗', en: 'Failed to write room file' }),
		levelLoading: beammpLocaleText($translate, { zh: '正在读取本地地图列表...', zhHant: '正在讀取本地地圖清單...', en: 'Reading local map list...' }),
		levelFallback: beammpLocaleText($translate, { zh: '未读取到地图列表，已启用默认地图（可手动填入模组地图路径）', zhHant: '未讀取到地圖清單，已啟用預設地圖（可手動填入模組地圖路徑）', en: 'Map list unavailable, fallback maps enabled (you can manually set mod map path).' })
	};
	vm.etOptions = beammpBuildEtOptionDefs($translate);
	vm.levelHint = vm.i18n.levelLoading;
	vm.levels = [];
	vm.form = {
		id: '',
		displayName: '',
		name: '',
		port: 30814,
		maxPlayers: 8,
		maxCars: 1,
		map: '/levels/gridmap_v2/info.json',
		description: '',
		tags: '',
		logChat: true,
		informationPacket: true,
		debug: false,
		bindIp: '0.0.0.0',
		hideUpdateMessages: true,
		remoteMultiplayerEnabled: false,
		remoteRoomPassword: '',
		remoteEasyTierRpcPortal: '127.0.0.1:15888',
		remoteVirtualListenPort: 30814,
		remoteEasyTierPeers: BEAMMP_DEFAULT_ET_PEERS,
		etDhcp: true,
		etLatencyFirst: false,
		etUseSmoltcp: false,
		etDisableIpv6: false,
		etEnableKcpProxy: false,
		etDisableKcpInput: false,
		etEnableQuicProxy: false,
		etDisableQuicInput: false,
		etDisableP2p: false,
		etBindDevice: true,
		etNoTun: false,
		etEnableExitNode: false,
		etRelayAllPeerRpc: false,
		etMultiThread: true,
		etProxyForwardBySystem: false,
		etDisableEncryption: false,
		etDisableUdpHolePunching: false,
		etDisableSymHolePunching: false,
		etAcceptDns: false,
		etPrivateMode: false
	};
	if (!vm.isEdit && !String(vm.form.remoteEasyTierPeers || '').trim().length)
		vm.form.remoteEasyTierPeers = BEAMMP_DEFAULT_ET_PEERS;
	$scope.$watch(function() { return vm.form.remoteMultiplayerEnabled; }, function(enabled) {
		if (enabled && !String(vm.form.remoteEasyTierPeers || '').trim().length)
			vm.form.remoteEasyTierPeers = BEAMMP_DEFAULT_ET_PEERS;
	});
	var fallbackLevels = [
		{ title: 'Gridmap v2', misFilePath: '/levels/gridmap_v2/info.json' },
		{ title: 'West Coast, USA', misFilePath: '/levels/west_coast_usa/info.json' },
		{ title: 'East Coast, USA', misFilePath: '/levels/east_coast_usa/info.json' },
		{ title: 'Italy', misFilePath: '/levels/italy/info.json' }
	];

	function normalizeLevels(raw) {
		var arr = raw;
		if (typeof raw === 'string') {
			try {
				arr = JSON.parse(raw || '[]');
			} catch (e) {
				arr = [];
			}
		}
		if (!Array.isArray(arr) && arr && typeof arr === 'object') {
			var list = [];
			angular.forEach(arr, function(v) { list.push(v); });
			arr = list;
		}
		if (!Array.isArray(arr))
			arr = [];
		var normalized = [];
		angular.forEach(arr, function(lv) {
			if (!lv)
				return;
			var p = lv.misFilePath || lv.levelPath || lv.mission || lv.path;
			if (typeof p !== 'string' || !p.length)
				return;
			normalized.push({
				title: lv.title || lv.levelName || lv.name || p,
				misFilePath: p
			});
		});
		return normalized;
	}

	function applyLevels(parsed, sourceName) {
		vm.levels = parsed;
		vm.levelHint = trRoomForm({
			zh: '已加载 ' + parsed.length + ' 张地图（来源: ' + sourceName + '）',
			zhHant: '已載入 ' + parsed.length + ' 張地圖（來源: ' + sourceName + '）',
			en: 'Loaded ' + parsed.length + ' maps (source: ' + sourceName + ')'
		});
		var hasCurrent = false;
		angular.forEach(parsed, function(lv) {
			if (lv.misFilePath === vm.form.map)
				hasCurrent = true;
		});
		if (!hasCurrent && parsed[0])
			vm.form.map = parsed[0].misFilePath;
	}

	function loadLevels(attempt) {
		bngApi.engineLua('MPCoreNetwork.getLocalLevelsJson()', function(data) {
			$scope.$evalAsync(function() {
				var parsed = normalizeLevels(data);
				if (parsed.length > 0) {
					applyLevels(parsed, 'MPCoreNetwork.getLocalLevelsJson');
				} else if (attempt < 5) {
					// 备用路径：直接读取 core_levels（含原版+模组）
					bngApi.engineLua('jsonEncode(core_levels.getList() or {})', function(raw2) {
						$scope.$evalAsync(function() {
							var parsed2 = normalizeLevels(raw2);
							if (parsed2.length > 0) {
								applyLevels(parsed2, 'core_levels.getList');
								return;
							}
							vm.levelHint = trRoomForm({
								zh: '地图列表准备中，重试 ' + (attempt + 1) + '/5 ...',
								zhHant: '地圖清單準備中，重試 ' + (attempt + 1) + '/5 ...',
								en: 'Map list preparing, retry ' + (attempt + 1) + '/5 ...'
							});
							$timeout(function() { loadLevels(attempt + 1); }, 800);
						});
					});
				} else {
				vm.levels = fallbackLevels;
				vm.levelHint = vm.i18n.levelFallback;
				vm.form.map = vm.form.map || '/levels/gridmap_v2/info.json';
			}
			});
		});
	}

	var editLoaded = false;
	var off = $rootScope.$on('roomHostResult', function(ev, data) {
		if (!data)
			return;
		if (data.error) {
			var saveFailedTitle = trRoomForm({ zh: '保存失败', zhHant: '儲存失敗', en: 'Save Failed' });
			var msg = data.error;
			if (msg === 'stop the running room before editing')
				msg = trRoomForm({ zh: '该房间正在运行，请先停止服务再编辑', zhHant: '該房間正在運行，請先停止服務再編輯', en: 'Room is running. Stop service before editing.' });
			if (msg === 'stop the room server before editing room configs')
				msg = trRoomForm({ zh: '请先停止服务', zhHant: '請先停止服務', en: 'Please stop service first' });
			if (msg === 'Remote multiplayer requires a room password')
				msg = trRoomForm({ zh: '远程联机需要设置房间密码', zhHant: '遠端連線需要設定房間密碼', en: 'Remote multiplayer requires room password' });
			if (msg === 'failed to write room file')
				msg = trRoomForm({ zh: '保存房间文件失败', zhHant: '儲存房間檔案失敗', en: 'Failed to write room file' });
			toastr.error(msg, saveFailedTitle, { timeOut: 5000, closeButton: true, positionClass: 'toast-top-center' });
		}
		if (vm.isEdit && data.room && data.room.id && String($stateParams.roomId) === String(data.room.id) && !data.saved && !editLoaded) {
			angular.extend(vm.form, data.room);
			editLoaded = true;
		}
		if (data.ok && data.saved && data.room)
			$state.go('menu.multiplayer.rooms');
		$scope.$applyAsync();
	});

	if (vm.isEdit && $stateParams.roomId) {
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('GET:' + $stateParams.roomId) + ')');
	}

	vm.goRooms = function() {
		$timeout(function() { $state.go('menu.multiplayer.rooms'); }, 0);
	};

	vm.submit = function() {
		var j = angular.copy(vm.form);
		j.displayName = (j.displayName || '').replace(/^\s+|\s+$/g, '');
		if (!j.displayName.length) {
			toastr.error(
				trRoomForm({ zh: '请填写房间显示名称', zhHant: '請填寫房間顯示名稱', en: 'Please enter room display name' }),
				trRoomForm({ zh: '保存失败', zhHant: '儲存失敗', en: 'Save Failed' }),
				{ timeOut: 4000, closeButton: true, positionClass: 'toast-top-center' }
			);
			return;
		}
		j.name = (j.name || '').replace(/^\s+|\s+$/g, '');
		j.name = j.name || j.displayName;
		j.port = parseInt(j.port, 10) || 30814;
		j.maxPlayers = parseInt(j.maxPlayers, 10) || 8;
		j.maxCars = parseInt(j.maxCars, 10) || 1;
		j.map = j.map || '/levels/gridmap_v2/info.json';
		j.description = (j.description || '').replace(/^\s+|\s+$/g, '');
		j.tags = (j.tags || '').replace(/^\s+|\s+$/g, '');
		j.bindIp = j.bindIp || '0.0.0.0';
		j.allowGuests = true;
		j.debug = !!j.debug;
		j.hideUpdateMessages = j.hideUpdateMessages !== false;
		j.remoteMultiplayerEnabled = !!j.remoteMultiplayerEnabled;
		var etBoolKeys = ['etDhcp','etLatencyFirst','etUseSmoltcp','etDisableIpv6',
			'etEnableKcpProxy','etDisableKcpInput','etEnableQuicProxy','etDisableQuicInput',
			'etDisableP2p','etBindDevice','etNoTun','etEnableExitNode','etRelayAllPeerRpc',
			'etMultiThread','etProxyForwardBySystem','etDisableEncryption',
			'etDisableUdpHolePunching','etDisableSymHolePunching','etAcceptDns','etPrivateMode'];
		angular.forEach(etBoolKeys, function(k) { j[k] = !!j[k]; });
		if (!j.remoteMultiplayerEnabled) {
			j.remoteRoomPassword = '';
			j.remoteEasyTierPeers = '';
		} else {
			j.remoteEasyTierRpcPortal = (j.remoteEasyTierRpcPortal || '127.0.0.1:15888').replace(/^\s+|\s+$/g, '');
			if (!j.remoteEasyTierRpcPortal.length)
				j.remoteEasyTierRpcPortal = '127.0.0.1:15888';
			j.remoteVirtualListenPort = parseInt(j.remoteVirtualListenPort, 10) || 30814;
			j.remoteEasyTierPeers = (j.remoteEasyTierPeers || '').replace(/^\s+|\s+$/g, '');
		}
		if (!vm.isEdit)
			delete j.id;
		bngApi.engineLua('MPCoreNetwork.roomHostSave(' + bngApi.serializeToLua(JSON.stringify(j)) + ')');
	};

	loadLevels(0);
	$scope.$on('$destroy', off);
}])

.controller('MultiplayerGuestRoomFormController', ['$scope', '$rootScope', '$state', '$stateParams', '$timeout', 'toastr', '$translate',
function($scope, $rootScope, $state, $stateParams, $timeout, toastr, $translate) {
	var vm = this;
	vm.isEdit = !!($stateParams && $stateParams.roomId);
	vm.i18n = {
		titleEdit: beammpLocaleText($translate, { zh: '编辑房间配置', zhHant: '編輯房間設定', en: 'Edit Room Config' }),
		titleCreate: beammpLocaleText($translate, { zh: '新建房间配置', zhHant: '建立房間設定', en: 'Create Room Config' }),
		hint: beammpLocaleText($translate, { zh: '用于作为访客加入远程房间（EasyTier）。带 * 为必填项；未标 * 的字段可留空。', zhHant: '用於作為訪客加入遠端房間（EasyTier）。帶 * 為必填項；未標 * 的欄位可留空。', en: 'Used to join remote rooms as guest (EasyTier). Fields marked with * are required; others can be left empty.' }),
		roomName: beammpLocaleText($translate, { zh: '房间名称 *', zhHant: '房間名稱 *', en: 'Room Name *' }),
		roomPassword: beammpLocaleText($translate, { zh: '房间密码 *', zhHant: '房間密碼 *', en: 'Room Password *' }),
		rpcPortal: beammpLocaleText($translate, { zh: 'EasyTier RPC 地址', zhHant: 'EasyTier RPC 位址', en: 'EasyTier RPC Portal' }),
		virtualPort: beammpLocaleText($translate, { zh: '虚拟监听端口', zhHant: '虛擬監聽連接埠', en: 'Virtual Listen Port' }),
		publicNodes: beammpLocaleText($translate, { zh: '公共节点（需要连接到房主所在节点或可互通的节点，否则无法加入正确房间）', zhHant: '公共節點（需連到房主所在節點或可互通節點，否則無法加入正確房間）', en: 'Public Nodes (Must reach host-side nodes)' }),
		publicNodesPlaceholder: beammpLocaleText($translate, { zh: '支持\",\"，\";\"分隔，多节点可混填（可省略 tcp://）', zhHant: '支援\",\"、\";\"分隔，多節點可混填（可省略 tcp://）', en: 'Use \",\" or \";\" between nodes; tcp:// optional' }),
		advanced: beammpLocaleText($translate, { zh: '高级设置', zhHant: '進階設定', en: 'Advanced Settings' }),
		save: beammpLocaleText($translate, { zh: '保存', zhHant: '儲存', en: 'Save' }),
		cancel: beammpLocaleText($translate, { zh: '取消 / 返回', zhHant: '取消 / 返回', en: 'Cancel / Back' }),
		saveFailed: beammpLocaleText($translate, { zh: '保存失败', zhHant: '儲存失敗', en: 'Save Failed' }),
		needRoomName: beammpLocaleText($translate, { zh: '请填写房间名称', zhHant: '請填寫房間名稱', en: 'Please enter room name' }),
		leaveBeforeEdit: beammpLocaleText($translate, { zh: '该房间正在连接中，请先退出再编辑', zhHant: '該房間連線中，請先退出再編輯', en: 'Room is connected. Leave before editing.' }),
		leaveCurrentFirst: beammpLocaleText($translate, { zh: '请先退出当前房间', zhHant: '請先退出目前房間', en: 'Please leave current room first' }),
		requirePassword: beammpLocaleText($translate, { zh: '远程联机需要设置房间密码', zhHant: '遠端連線需要設定房間密碼', en: 'Remote multiplayer requires room password' }),
		writeRoomFailed: beammpLocaleText($translate, { zh: '保存房间文件失败', zhHant: '儲存房間檔案失敗', en: 'Failed to write room file' })
	};
	vm.etOptions = beammpBuildEtOptionDefs($translate);
	vm.form = {
		id: '',
		kind: 'guestRoom',
		displayName: '',
		name: '',
		remoteRoomPassword: '',
		remoteEasyTierRpcPortal: '127.0.0.1:15889',
		remoteVirtualListenPort: 30814,
		remoteEasyTierPeers: BEAMMP_DEFAULT_ET_PEERS,
		etDhcp: true,
		etLatencyFirst: false,
		etUseSmoltcp: false,
		etDisableIpv6: false,
		etEnableKcpProxy: false,
		etDisableKcpInput: false,
		etEnableQuicProxy: false,
		etDisableQuicInput: false,
		etDisableP2p: false,
		etBindDevice: true,
		etNoTun: false,
		etEnableExitNode: false,
		etRelayAllPeerRpc: false,
		etMultiThread: true,
		etProxyForwardBySystem: false,
		etDisableEncryption: false,
		etDisableUdpHolePunching: false,
		etDisableSymHolePunching: false,
		etAcceptDns: false,
		etPrivateMode: false
	};
	if (!vm.isEdit && !String(vm.form.remoteEasyTierPeers || '').trim().length)
		vm.form.remoteEasyTierPeers = BEAMMP_DEFAULT_ET_PEERS;

	var editLoaded = false;
	var off = $rootScope.$on('roomHostResult', function(ev, data) {
		if (!data)
			return;
		if (data.error) {
			var saveFailedTitleGuest = beammpLocaleText($translate, { zh: '保存失败', zhHant: '儲存失敗', en: 'Save Failed' });
			var msg = data.error;
			if (msg === 'leave the joined room before editing')
				msg = beammpLocaleText($translate, { zh: '该房间正在连接中，请先退出再编辑', zhHant: '該房間連線中，請先退出再編輯', en: 'Room is connected. Leave before editing.' });
			if (msg === 'please leave current guest room before editing room configs')
				msg = beammpLocaleText($translate, { zh: '请先退出当前房间', zhHant: '請先退出目前房間', en: 'Please leave current room first' });
			if (msg === 'Remote multiplayer requires a room password')
				msg = beammpLocaleText($translate, { zh: '远程联机需要设置房间密码', zhHant: '遠端連線需要設定房間密碼', en: 'Remote multiplayer requires room password' });
			if (msg === 'failed to write room file')
				msg = beammpLocaleText($translate, { zh: '保存房间文件失败', zhHant: '儲存房間檔案失敗', en: 'Failed to write room file' });
			toastr.error(msg, saveFailedTitleGuest, { timeOut: 5000, closeButton: true, positionClass: 'toast-top-center' });
		}
		if (vm.isEdit && data.room && data.room.id && String($stateParams.roomId) === String(data.room.id) && !data.saved && !editLoaded) {
			angular.extend(vm.form, data.room);
			editLoaded = true;
		}
		if (data.ok && data.saved && data.room && data.room.kind === 'guestRoom')
			$state.go('menu.multiplayer.direct');
		$scope.$applyAsync();
	});

	if (vm.isEdit && $stateParams.roomId) {
		bngApi.engineLua('MPCoreNetwork.roomHostSend(' + bngApi.serializeToLua('GET:' + $stateParams.roomId) + ')');
	}

	vm.goBack = function() {
		$timeout(function() { $state.go('menu.multiplayer.direct'); }, 0);
	};

	vm.submit = function() {
		var j = angular.copy(vm.form);
		j.kind = 'guestRoom';
		j.displayName = (j.displayName || '').replace(/^\s+|\s+$/g, '');
		if (!j.displayName.length) {
			toastr.error(
				beammpLocaleText($translate, { zh: '请填写房间名称', zhHant: '請填寫房間名稱', en: 'Please enter room name' }),
				beammpLocaleText($translate, { zh: '保存失败', zhHant: '儲存失敗', en: 'Save Failed' }),
				{ timeOut: 4000, closeButton: true, positionClass: 'toast-top-center' }
			);
			return;
		}
		j.name = j.displayName;
		j.remoteMultiplayerEnabled = true;
		j.remoteRoomPassword = (j.remoteRoomPassword || '').replace(/^\s+|\s+$/g, '');
		j.remoteEasyTierRpcPortal = (j.remoteEasyTierRpcPortal || '127.0.0.1:15889').replace(/^\s+|\s+$/g, '');
		if (!j.remoteEasyTierRpcPortal.length)
			j.remoteEasyTierRpcPortal = '127.0.0.1:15889';
		j.remoteVirtualListenPort = parseInt(j.remoteVirtualListenPort, 10) || 30814;
		j.remoteEasyTierPeers = (j.remoteEasyTierPeers || '').replace(/^\s+|\s+$/g, '');
		var etBoolKeys = ['etDhcp','etLatencyFirst','etUseSmoltcp','etDisableIpv6',
			'etEnableKcpProxy','etDisableKcpInput','etEnableQuicProxy','etDisableQuicInput',
			'etDisableP2p','etBindDevice','etNoTun','etEnableExitNode','etRelayAllPeerRpc',
			'etMultiThread','etProxyForwardBySystem','etDisableEncryption',
			'etDisableUdpHolePunching','etDisableSymHolePunching','etAcceptDns','etPrivateMode'];
		angular.forEach(etBoolKeys, function(k) { j[k] = !!j[k]; });
		if (!vm.isEdit)
			delete j.id;
		bngApi.engineLua('MPCoreNetwork.roomHostSave(' + bngApi.serializeToLua(JSON.stringify(j)) + ')');
	};

	$scope.$on('$destroy', off);
}])

.directive('compile', ['$compile', function ($compile) {
  return function(scope, element, attrs) {
    scope.$watch(
      function(scope) {
        // watch the 'compile' expression for changes
        return scope.$eval(attrs.compile);
      },
      function(value) {
        // when the 'compile' expression changes
        // assign it into the current DOM
        element.html(value);
				// compile the new DOM and link it to the current
			  // scope.
			  // NOTE: we only compile .childNodes so that
			  // we don't get into infinite loop compiling ourselves
			  $compile(element.contents())(scope);
			}
		);
	};
}])




/* //////////////////////////////////////////////////////////////////////////////////////////////
*	FUNCTIONS
*/ //////////////////////////////////////////////////////////////////////////////////////////////
// Set the first letter of each word upper case
function toTitleCase(str) {
	return str.replace(/\w\S*/g, function(txt){
		return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
	});
}

function SmoothMapName(map) {
	if (!map) return;
	map = map.replace("/info.json","")
	map = map.split('/').pop().replace(/\s*/g,'')
	map = map.replace(/_/g," ")
	map = map.replace(/-/g," ")
	map = toTitleCase(map)
	return map
}

function formatBytes(bytes = 0, decimals = 2) {
    if (bytes == 0 || bytes == undefined) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

globalThis.serverStyleMap = {
    '^0': 'color-0',
    '^1': 'color-1',
    '^2': 'color-2',
    '^3': 'color-3',
    '^4': 'color-4',
    '^5': 'color-5',
    '^6': 'color-6',
    '^7': 'color-7',
    '^8': 'color-8',
    '^9': 'color-9',
    '^a': 'color-a',
    '^b': 'color-b',
    '^c': 'color-c',
    '^d': 'color-d',
    '^e': 'color-e',
    '^f': 'color-f',
    '^l': 'bold',
    '^m': 'line-through',
    '^n': 'underline',
    '^o': 'italic'
};

function formatCodes(string, isdesc = false) {
    let result = '';
    let currentText = '';
    let classes = new Set();

	string = DOMPurify.sanitize(string)

    const tokens = string.split(/(\^.)/g);

    const flush = () => {
        if (!currentText) return;
        const classList = Array.from(classes);
        result += classList.length
            ? `<span class="${classList.join(' ')}">${currentText}</span>`
            : currentText;
        currentText = '';
    };

    for (const token of tokens) {
        if (/^\^.$/.test(token)) {
            flush();
            if (token === '^r') {
                classes.clear();
            } else if (isdesc && token === '^p') {
                currentText += '<br>';
            } else {
                const cls = globalThis.serverStyleMap?.[token];
                if (cls?.startsWith('color-')) {
                    [...classes].forEach(c => c.startsWith('color-') && classes.delete(c));
                    classes.add(cls);
                } else if (cls) {
                    classes.add(cls);
                }
            }
        } else {
            currentText += token;
        }
    }

    flush();
    return result;
}


function modCount(s) {
	if(s.length==0) return 0;
	return s.split(";").length-1;
}

function modList(s) {
	var modarray = s.split(';');
	
	// Sort the mod array alphabetically
  	modarray.sort();

	s = "";
	for (var i=0; i<modarray.length; i++){
		if (modarray[i] != '') {
			var modName = modarray[i].split('/').pop();
			modName = modName.replace(".zip","");
			s += modName;
			//if (i<modarray.length-2)
			s += ", ";
		}
	}
	//console.log(s);
	s = s.substring(0, s.length -2);
	return s
}

function returnDefault(data, type) {
	if (data == undefined || data == null) {
		switch (type) {
			case "Number":
				return 0
			case "String":
				return "Not set"
		}
	}
	else return data;
}


function listPlayers(s) {
	if (s != undefined || s != "") {
		var re = new RegExp(";", 'g');
		s = s.replace(re, ', ');
		s = s.substring(0, s.length -2);
		return "Current players: " + s
	} else {
		return "No players..."
	}
}

var serverStyleArray = [
    "^0",
    "^1",
    "^2",
    "^3",
    "^4",
    "^5",
    "^6",
    "^7",
    "^8",
    "^9",
    "^a",
    "^b",
    "^c",
    "^d",
    "^e",
    "^f",
    "^l",
    "^m",
    "^n",
    "^o",
    "^r",
    "^p"
];

function stripCustomFormatting(name){
	for (var i = 0; i < serverStyleArray.length; i++){
		while (name.includes(serverStyleArray[i])){
			name = name.replace(serverStyleArray[i], "");
		}
	}
	return name;
}



globalThis.openExternalLink = function(url){
	bngApi.engineLua(`MPCoreNetwork.openURL("`+url+`")`);
}

async function populateTable($filter, $scope, servers, tab, searchText = '', checkIsEmpty, checkIsNotEmpty, checkIsNotFull, checkModSlider, sliderMaxModSize, selectMap = 'Any map', SelectedServerVersions = [], tags = [], SelectedServerLocations = []) {
	$scope.serversTable = {};
	let i = 0;
	for (const server of servers) {
		i += 1;
		if (!server) {
			break;
		}

		//server.tags = "tag1,tag2"
		var serverTags = server.tags.toLowerCase().split(",").map(tag => tag.trim());

		var missingTag = false;
		for (let tag of tags) {
			if (!serverTags.includes(tag.toLowerCase())) missingTag = true;
		}

		if (missingTag) continue;

		var shown = true;
		var smoothMapName = SmoothMapName(server.map);

		// Filter by search
		if (!server.strippedName.toLowerCase().includes(searchText.toLowerCase())) continue;
		
		// Filter by empty or full
		else if(checkIsEmpty && server.players > 0) continue;
		else if(checkIsNotEmpty && server.players == 0) continue;
		else if(checkIsNotFull && server.players >= parseInt(server.maxplayers)) continue;
		
		// Filter by mod size
		else if(checkModSlider && sliderMaxModSize * 1048576 < server.modstotalsize) continue;
	
		// Filter by map
		else if((selectMap != "Any map" && selectMap != smoothMapName)) continue;

		else if (SelectedServerVersions.length > 0 && !SelectedServerVersions.includes("v" + server.version)) continue;

		else if (SelectedServerLocations.length > 0 && !SelectedServerLocations.includes(server.location)) continue;

		// If the server passed the filter

		$scope.serversTable[server.ip + ":" + server.port] = {server: server, isFavorite: false, isRecent: false, name: server.sname, offline: false, custom: false};
		$scope.serversArray = Object.keys($scope.serversTable).map(function(key) {
			return $scope.serversTable[key];
		});

	}

	if (Object.keys($scope.serversTable).length === 0) {
    	$scope.serversArray = [];
	}	
	$scope.serversArray.forEach(server => {
		server.id = server.server.ip + ':' + server.server.port;
	});
	$scope.onScroll();
}

// Used to connect to the backend with ids
function connect(ip, port, name, skipModWarning = false) {
	console.log("Attempting to call connect to server...")
	// Make sure the right content is displayed
	document.getElementById('OriginalLoadingStatus').removeAttribute("hidden");
	document.getElementById('LoadingStatus').setAttribute("hidden", "hidden");
	// Show the connecting screen
	document.getElementById('LoadingServer').style.display = 'flex'

	let modlist = document.getElementById('mod-download-list');
	if (modlist) {
		modlist.style.display = 'none';
	}

	const injector = angular.element(document.body).injector();
	const $controller = injector.get('$controller');
	const $rootScope = injector.get('$rootScope');
	const multiplayerCtrl = $controller('MultiplayerController', { $scope: $rootScope });

	multiplayerCtrl.loadingStatus = ""
	multiplayerCtrl.downloadingMods = [];
	$rootScope.$applyAsync();

	document.getElementById('loadingstatus-divider').style.display = "none";

	// Connect with ids
	bngApi.engineLua('MPCoreNetwork.connectToServer("' + ip + '", ' + port + ',"' + name + '", ' + skipModWarning + ')');
}

async function receiveServers(data) {
	var serversArray = new Array();
	var launcherVersion = await getLauncherVersion();
	// Parse the data to a nice looking Array
	for (var i = 0; i < data.length; i++) {
		var v = data[i]
		const [vMajor, vMinor] = v.cversion.split('.').map(Number);
		const [launcherMajor, launcherMinor] = launcherVersion.split('.').map(Number);

		// Compare the versions
		if (vMajor === launcherMajor && launcherMinor >= vMinor) {
			v.strippedName = stripCustomFormatting(v.sname);
			serversArray.push(v);
		}
	}
	serversArray.sort(function(a, b) {
		return a.strippedName.localeCompare(b.strippedName);
	});
	return serversArray;
};

async function getLauncherVersion() {
	return new Promise(function(resolve, reject) {
		bngApi.engineLua("MPCoreNetwork.getLauncherVersion()", (data) => {
			resolve(data);
		});
	});
}

async function isLoggedIn() {
	return new Promise(function(resolve, reject) {
		bngApi.engineLua("MPCoreNetwork.isLoggedIn()", (data) => {
			resolve(data);
		});
	});
}

async function isLauncherConnected() {
	return new Promise(function(resolve, reject) {
		bngApi.engineLua("MPCoreNetwork.isLauncherConnected()", (data) => {
			resolve(data);
		});
	});
}



// Base64 encoding and decoding functions
var Base64 = {
    encode: function(input) {
        return btoa(new TextEncoder().encode(input).reduce((data, byte) => data + String.fromCharCode(byte), ""));
    },
    decode: function(input) {
        return new TextDecoder().decode(Uint8Array.from(atob(input), c => c.charCodeAt(0)));
    }
};
