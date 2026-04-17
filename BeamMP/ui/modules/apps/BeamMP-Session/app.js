// Copyright (C) 2024 BeamMP Ltd., BeamMP team and contributors.
// Licensed under AGPL-3.0 (or later), see <https://www.gnu.org/licenses/>.
// SPDX-License-Identifier: AGPL-3.0-or-later

var app = angular.module('beamng.apps');
var mdDialog;
var mdDialogVisible = false;
import('/ui/lib/ext/purify.min.js')
app.directive('multiplayersession', [function () {
	return {
		templateUrl: '/ui/modules/apps/BeamMP-Session/app.html',
		replace: true,
		restrict: 'EA',
		scope: true,
		controllerAs: 'ctrl'
	}
}]);

app.controller("Session", ['$scope', '$mdDialog', 'Settings', function ($scope, $mdDialog, Settings) {

	const applySessionStyle = function(useNewDesign) {
		const stylesheet = document.getElementById('session-style');
		if (!stylesheet) return;

		let newStylePath = useNewDesign ? '/ui/modules/apps/BeamMP-Session/redesign.css' : '/ui/modules/apps/BeamMP-Session/app.css';
		
		if (stylesheet.getAttribute('href') !== newStylePath) {
			stylesheet.setAttribute('href', newStylePath);
		}
	};

	$scope.init = function() {
		applySessionStyle(Settings.values.useUiAppRedesign);
		bngApi.engineLua('UI.setServerName()'); // request server name
		bngApi.engineLua('UI.sendQueue()'); // request queue data
		//TODO: ping request to instantly populate the player count
	};

	mdDialog = $mdDialog;

	$scope.mpquit = function() {
		bngApi.engineLua('MPCoreNetwork.leaveServer(true)');
	};

	$scope.applyQueue = function() {
		bngApi.engineLua('MPVehicleGE.applyQueuedEvents()');
	};

	$scope.reset = function() {
		$scope.init();
	};

	$scope.select = function() {
		bngApi.engineLua('setCEFFocus(true)');
	};

	$scope.$on('SettingsChanged', function (event, data) {
		Settings.values = data.values;
		applySessionStyle(Settings.values.useUiAppRedesign);
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

	$scope.$on('setPing', function (event, ping) {
		var sessionPing = document.getElementById("Session-Ping")
		// To ensure that the element exists
		if (sessionPing) {
			sessionPing.innerHTML = ping;
		}
	});

	$scope.$on('setQueue', function (event, queue) {
		var queueBlock = document.getElementById("queue-block");
		// To ensure that the element exists
		if (queueBlock) {
			if (queue.show) {
				queueBlock.style["background-position"] = "0%";
				queueBlock.style.display = "";
			} else {
				queueBlock.style.display = "none";
				return;
			}
		}

		var queueCount = queue.editCount + queue.spawnCount;
		var queueElem = document.getElementById("Session-Queue")
		queueElem.innerHTML = `${queue.spawnCount}|${queue.editCount}`;
		queueElem.title = `Edits: ${queue.editCount}\nSpawns: ${queue.spawnCount}`; // titles dont work in game :C

	});

	$scope.$on('setAutoQueueProgress', function (event, progress) {
		document.getElementById('queue-block').style["background-position"] = progress + "%";
	});

	$scope.$on('setServerName', function (event, data) {
		//console.log('Setting status to: ' + sanitizeString(status))
		const block = document.getElementById('server-name-block');

		if (!data) block.style.display = "none";
		else {
			block.style.display = "";
			const marquee = block.querySelector('.marquee');
			let sessionStatus = document.getElementsByClassName("session-status");
			for (let i = 0; i < sessionStatus.length; i++) {
				sessionStatus[i].innerHTML = formatServerName(data); // DISPLAY SERVER NAME FORMATTING
				if (isMarqueeNeeded(sessionStatus[i])) {
					marquee.classList.add('activate-marquee');
				} else {
					marquee.classList.remove('activate-marquee');
					break;
				}
			}
		}
	});

	$scope.$on('setPlayerCount', function (event, count) {
		document.getElementById("Session-PlayerCount").innerHTML = count;
	});
}]);



function formatServerName(string) {
    let result = '';
    let currentText = '';
    let classes = new Set();

	string = DOMPurify.sanitize(string);

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

function isMarqueeNeeded(element) {
	const block = document.getElementById('server-name-block');
    return element.offsetWidth > block.getBoundingClientRect().width;
}
