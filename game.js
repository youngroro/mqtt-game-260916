'use strict';

// GitHub Pages-friendly MQTT race game.
// No backend, no Docker, no Node.js server.
// Every browser connects directly to MQTT over Secure WebSocket.

const MQTT_WS_URL = 'wss://broker.emqx.io:8084/mqtt';
const TOPIC_ROOT = 'mqtt-browser-race-v1';
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_STALE_MS = 15000;
const ROOM_HEARTBEAT_MS = 5000;
const JOIN_TIMEOUT_MS = 4000;

const RUNNER_EMOJIS = ['🏃', '🐰', '🐱', '🐶', '🦊', '🐼', '🐸', '🐵'];

let playerId = createId();
let playerName = '';
let roomId = null;
let hostId = null;
let isHost = false;
let roomState = 'waiting';
let finishDistance = 30;
let mqttClient = null;
let roomHeartbeatTimer = null;
let roomListTimer = null;
let joinTimeoutTimer = null;

// Authoritative room state is kept by the host.
const roomPlayers = new Map();

// Local view of positions on every browser.
const positions = new Map();
const discoveredRooms = new Map();

const $ = (id) => document.getElementById(id);

const screens = {
  login: $('screen-login'),
  lobby: $('screen-lobby'),
  game: $('screen-game'),
  result: $('screen-result'),
};

function createId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 5; i += 1) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.hidden = key !== name;
  });
}

function setConnectionStatus(connected) {
  const el = $('connStatus');
  el.textContent = connected ? 'MQTT：已連線' : 'MQTT：連線中...';
  el.classList.toggle('online', connected);
  el.classList.toggle('offline', !connected);
}

function setError(message = '') {
  $('loginError').textContent = message;
}

function getNickname() {
  const name = $('nicknameInput').value.trim();
  if (!name) {
    setError('請先輸入暱稱');
    return null;
  }
  setError('');
  return name.slice(0, 16);
}

function publish(topic, payload, options = {}) {
  if (!mqttClient?.connected) return false;

  mqttClient.publish(topic, JSON.stringify(payload), {
    qos: 0,
    retain: Boolean(options.retain),
  });

  return true;
}

function clearRetained(topic) {
  if (!mqttClient?.connected) return;
  mqttClient.publish(topic, '', { qos: 0, retain: true });
}

function connectMqtt() {
  if (mqttClient) return;

  mqttClient = mqtt.connect(MQTT_WS_URL, {
    clientId: `race-web-${createId()}`,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 10000,
  });

  mqttClient.on('connect', () => {
    setConnectionStatus(true);
    mqttClient.subscribe(`${TOPIC_ROOT}/rooms/+/meta`);

    if (roomId) {
      subscribeRoom(roomId);
      if (isHost) {
        publishHostSnapshot();
        startRoomHeartbeat();
      }
    }

    renderRoomList();
  });

  mqttClient.on('reconnect', () => setConnectionStatus(false));
  mqttClient.on('close', () => setConnectionStatus(false));
  mqttClient.on('offline', () => setConnectionStatus(false));
  mqttClient.on('error', (err) => console.error('MQTT error:', err));

  mqttClient.on('message', (topic, payloadBuffer) => {
    let data;

    try {
      data = JSON.parse(payloadBuffer.toString());
    } catch {
      return;
    }

    if (topic.startsWith(`${TOPIC_ROOT}/rooms/`) && topic.endsWith('/meta')) {
      handleRoomMeta(topic, data);
      return;
    }

    if (!roomId || !topic.startsWith(`${TOPIC_ROOT}/game/${roomId}/`)) return;

    const subTopic = topic.slice(`${TOPIC_ROOT}/game/${roomId}/`.length);
    handleRoomMessage(subTopic, data);
  });
}

function subscribeRoom(code) {
  mqttClient?.subscribe(`${TOPIC_ROOT}/game/${code}/#`);
}

function handleRoomMeta(topic, data) {
  const parts = topic.split('/');
  const code = parts[2];

  if (!code || !data) return;

  discoveredRooms.set(code, {
    ...data,
    roomId: code,
  });

  renderRoomList();
}

function renderRoomList() {
  const list = $('roomList');
  if (!list) return;

  const now = Date.now();
  const rooms = [...discoveredRooms.values()]
    .filter((room) => room.state === 'waiting')
    .filter((room) => now - Number(room.updatedAt || 0) <= ROOM_STALE_MS)
    .sort((a, b) => String(a.roomId).localeCompare(String(b.roomId)));

  list.innerHTML = '';

  if (rooms.length === 0) {
    const li = document.createElement('li');
    li.textContent = '目前沒有可加入的房間';
    list.appendChild(li);
    return;
  }

  rooms.forEach((room) => {
    const li = document.createElement('li');

    const info = document.createElement('span');
    info.textContent = `🏠 ${room.roomId}｜${room.hostName || '房主'}｜${room.finishDistance || 30} 格｜${room.playerCount || 1} 人`;

    const button = document.createElement('button');
    button.className = 'secondary small';
    button.textContent = '加入';
    button.addEventListener('click', () => doJoinRoom(room.roomId));

    li.append(info, button);
    list.appendChild(li);
  });
}

function doCreateRoom() {
  const name = getNickname();
  if (!name) return;

  if (!mqttClient?.connected) {
    setError('MQTT 尚未連線');
    return;
  }

  playerId = createId();
  playerName = name;
  roomId = generateRoomCode();
  hostId = playerId;
  isHost = true;
  roomState = 'waiting';
  finishDistance = Number($('finishDistanceSelect').value) || 30;

  roomPlayers.clear();
  positions.clear();

  roomPlayers.set(playerId, {
    id: playerId,
    name: playerName,
    position: 0,
  });
  positions.set(playerId, 0);

  subscribeRoom(roomId);
  enterLobby();
  publishHostSnapshot();
  startRoomHeartbeat();
}

function doJoinRoom(explicitCode) {
  const name = getNickname();
  if (!name) return;

  if (!mqttClient?.connected) {
    setError('MQTT 尚未連線');
    return;
  }

  const code = String(explicitCode || $('roomCodeInput').value)
    .trim()
    .toUpperCase();

  if (!code) {
    setError('請輸入房間代碼');
    return;
  }

  const knownRoom = discoveredRooms.get(code);
  if (knownRoom && Date.now() - Number(knownRoom.updatedAt || 0) > ROOM_STALE_MS) {
    setError('房間可能已離線');
    return;
  }

  playerId = createId();
  playerName = name;
  roomId = code;
  hostId = knownRoom?.hostId || null;
  isHost = false;
  roomState = 'waiting';
  finishDistance = Number(knownRoom?.finishDistance || 30);

  roomPlayers.clear();
  positions.clear();

  subscribeRoom(roomId);
  enterLobby();

  setTimeout(() => {
    publish(`${TOPIC_ROOT}/game/${roomId}/join/request`, {
      playerId,
      playerName,
      ts: Date.now(),
    });
  }, 120);

  clearTimeout(joinTimeoutTimer);
  joinTimeoutTimer = setTimeout(() => {
    if (!roomPlayers.has(playerId) && roomState === 'waiting') {
      setError('無法加入房間，房主可能已離線');
      roomId = null;
      showScreen('login');
    }
  }, JOIN_TIMEOUT_MS);
}

function enterLobby() {
  showScreen('lobby');
  $('lobbyRoomId').textContent = roomId || '-----';
  $('lobbyFinishDistance').textContent = finishDistance;
  $('startGameBtn').hidden = !isHost;
  $('lobbyWaitingMsg').hidden = isHost;
  renderLobbyPlayers();
}

function renderLobbyPlayers() {
  const list = $('lobbyPlayers');
  list.innerHTML = '';

  const players = [...roomPlayers.values()];

  if (players.length === 0) {
    const li = document.createElement('li');
    li.textContent = '等待玩家資料...';
    list.appendChild(li);
    return;
  }

  players.forEach((player) => {
    const li = document.createElement('li');
    li.textContent = player.id === hostId ? `👑 ${player.name}` : player.name;
    list.appendChild(li);
  });
}

function handleRoomMessage(subTopic, data) {
  switch (subTopic) {
    case 'join/request':
      if (isHost) hostHandleJoin(data);
      break;

    case 'join/rejected':
      if (data.playerId === playerId) {
        clearTimeout(joinTimeoutTimer);
        setError(data.message || '無法加入房間');
        roomId = null;
        showScreen('login');
      }
      break;

    case 'state':
      onStateUpdate(data);
      break;

    case 'players':
      onPlayersUpdate(data.players || []);
      break;

    case 'race/progress':
      onRaceProgress(data);
      break;

    case 'race/result':
      onRaceResult(data);
      break;

    default:
      break;
  }
}

function hostHandleJoin({ playerId: joiningId, playerName: joiningName } = {}) {
  if (!joiningId || !joiningName) return;

  if (roomState !== 'waiting') {
    publish(`${TOPIC_ROOT}/game/${roomId}/join/rejected`, {
      playerId: joiningId,
      message: '比賽已開始，無法加入',
    });
    return;
  }

  if (!roomPlayers.has(joiningId)) {
    roomPlayers.set(joiningId, {
      id: joiningId,
      name: String(joiningName).trim().slice(0, 16) || '玩家',
      position: 0,
    });
    positions.set(joiningId, 0);
  }

  publishPlayers();
  publishState();
  publishRoomMeta();
}

function publishHostSnapshot() {
  if (!isHost) return;
  publishState();
  publishPlayers();
  publishRoomMeta();
}

function publishState() {
  if (!isHost || !roomId) return;

  publish(
    `${TOPIC_ROOT}/game/${roomId}/state`,
    {
      roomId,
      state: roomState,
      hostId,
      finishDistance,
      updatedAt: Date.now(),
    },
    { retain: true },
  );
}

function publishPlayers() {
  if (!isHost || !roomId) return;

  publish(
    `${TOPIC_ROOT}/game/${roomId}/players`,
    {
      players: [...roomPlayers.values()],
    },
    { retain: true },
  );
}

function publishRoomMeta() {
  if (!isHost || !roomId) return;

  publish(
    `${TOPIC_ROOT}/rooms/${roomId}/meta`,
    {
      hostId,
      hostName: roomPlayers.get(hostId)?.name || playerName,
      finishDistance,
      playerCount: roomPlayers.size,
      state: roomState,
      updatedAt: Date.now(),
    },
    { retain: true },
  );
}

function startRoomHeartbeat() {
  clearInterval(roomHeartbeatTimer);
  publishRoomMeta();
  roomHeartbeatTimer = setInterval(publishRoomMeta, ROOM_HEARTBEAT_MS);
}

function onStateUpdate(data) {
  if (!data) return;

  roomState = data.state || roomState;
  hostId = data.hostId || hostId;
  finishDistance = Number(data.finishDistance || finishDistance);
  isHost = hostId === playerId;

  if (roomState === 'waiting') {
    enterLobby();
    return;
  }

  if (roomState === 'playing') {
    startGameScreen();
  }
}

function onPlayersUpdate(players) {
  clearTimeout(joinTimeoutTimer);

  roomPlayers.clear();

  players.forEach((player) => {
    const normalized = {
      id: player.id,
      name: player.name,
      position: Number(player.position || 0),
    };

    roomPlayers.set(normalized.id, normalized);

    if (!positions.has(normalized.id)) {
      positions.set(normalized.id, normalized.position);
    }
  });

  renderLobbyPlayers();

  if (roomState === 'playing') {
    renderRaceTrack();
  }
}

function hostStartGame() {
  if (!isHost || roomState !== 'waiting') return;

  roomState = 'playing';
  positions.clear();

  for (const player of roomPlayers.values()) {
    player.position = 0;
    positions.set(player.id, 0);
  }

  publishPlayers();
  publishState();
  publishRoomMeta();
  startGameScreen();
}

function startGameScreen() {
  showScreen('game');
  $('gameRoomId').textContent = roomId || '-----';
  $('gameFinishDistance').textContent = finishDistance;
  $('myFinishDistance').textContent = finishDistance;

  if (!positions.has(playerId)) {
    positions.set(playerId, roomPlayers.get(playerId)?.position || 0);
  }

  updateMyProgress();
  renderRaceTrack();
  $('runBtn').disabled = roomState !== 'playing';
}

function runOneStep() {
  if (roomState !== 'playing') return;
  if (!roomPlayers.has(playerId)) return;

  const currentPosition = positions.get(playerId) || 0;
  if (currentPosition >= finishDistance) return;

  // Important: local UI moves immediately. No MQTT round trip is required.
  const nextPosition = Math.min(finishDistance, currentPosition + 1);
  positions.set(playerId, nextPosition);

  const localPlayer = roomPlayers.get(playerId);
  if (localPlayer) localPlayer.position = nextPosition;

  updateRunner(playerId);
  updateMyProgress();

  // Broadcast an absolute position instead of a delta.
  // If a QoS 0 packet is lost, the next click still carries the newest position.
  publish(`${TOPIC_ROOT}/game/${roomId}/race/progress`, {
    playerId,
    playerName,
    position: nextPosition,
    ts: Date.now(),
  });

  // The host can finish its own race without waiting for its message to return.
  if (isHost) {
    hostAcceptProgress({
      playerId,
      playerName,
      position: nextPosition,
    });
  }
}

function onRaceProgress(data) {
  const racingPlayerId = data?.playerId;
  const incomingPosition = Number(data?.position);

  if (!racingPlayerId || !Number.isFinite(incomingPosition)) return;

  if (isHost) {
    hostAcceptProgress(data);
    return;
  }

  applyProgress(racingPlayerId, incomingPosition);
}

function hostAcceptProgress({ playerId: racingPlayerId, position } = {}) {
  if (!isHost || roomState !== 'playing') return;
  if (!racingPlayerId || !roomPlayers.has(racingPlayerId)) return;

  const incomingPosition = Math.max(0, Math.min(finishDistance, Number(position) || 0));
  const player = roomPlayers.get(racingPlayerId);
  const acceptedPosition = Math.max(Number(player.position || 0), incomingPosition);

  player.position = acceptedPosition;
  positions.set(racingPlayerId, acceptedPosition);
  updateRunner(racingPlayerId);

  if (acceptedPosition >= finishDistance) {
    hostFinishRace(racingPlayerId);
  }
}

function applyProgress(racingPlayerId, incomingPosition) {
  const safePosition = Math.max(0, Math.min(finishDistance, incomingPosition));
  const previousPosition = positions.get(racingPlayerId) || 0;

  // Ignore older/out-of-order MQTT packets.
  if (safePosition < previousPosition) return;

  positions.set(racingPlayerId, safePosition);

  const player = roomPlayers.get(racingPlayerId);
  if (player) player.position = safePosition;

  updateRunner(racingPlayerId);

  if (racingPlayerId === playerId) {
    updateMyProgress();
  }
}

function hostFinishRace(winnerId) {
  if (!isHost || roomState !== 'playing') return;

  roomState = 'ended';

  const leaderboard = [...roomPlayers.values()]
    .map((player) => ({
      playerId: player.id,
      name: player.name,
      position: Number(player.position || 0),
    }))
    .sort((a, b) => {
      if (a.playerId === winnerId) return -1;
      if (b.playerId === winnerId) return 1;
      return b.position - a.position || a.name.localeCompare(b.name);
    });

  publishState();
  publishRoomMeta();

  publish(
    `${TOPIC_ROOT}/game/${roomId}/race/result`,
    {
      winnerId,
      leaderboard,
      finishedAt: Date.now(),
    },
    { retain: true },
  );

  onRaceResult({ winnerId, leaderboard });
}

function onRaceResult({ winnerId, leaderboard } = {}) {
  if (!Array.isArray(leaderboard)) return;

  roomState = 'ended';
  $('runBtn').disabled = true;

  const winner = leaderboard.find((item) => item.playerId === winnerId);
  $('resultTitle').textContent = winner ? `${winner.name} 獲勝！` : '比賽結束！';

  const list = $('finalLeaderboard');
  list.innerHTML = '';

  leaderboard.forEach((item, index) => {
    const li = document.createElement('li');
    const prefix = index === 0 ? '🏆 ' : '';
    li.textContent = `${prefix}${item.name}：${item.position}/${finishDistance}`;
    if (item.playerId === playerId) li.classList.add('me');
    list.appendChild(li);
  });

  showScreen('result');
}

function renderRaceTrack() {
  const track = $('raceTrack');
  track.innerHTML = '';

  const players = [...roomPlayers.values()];

  players.forEach((player, index) => {
    const row = document.createElement('div');
    row.className = 'racer-row';
    row.dataset.playerId = player.id;

    const head = document.createElement('div');
    head.className = 'racer-head';

    const name = document.createElement('span');
    name.className = 'racer-name';
    if (player.id === playerId) name.classList.add('me');
    name.textContent = player.name;

    const progress = document.createElement('span');
    progress.className = 'racer-progress';
    progress.textContent = `${positions.get(player.id) || 0}/${finishDistance}`;

    head.append(name, progress);

    const line = document.createElement('div');
    line.className = 'track-line';

    const runner = document.createElement('div');
    runner.className = 'runner';
    runner.dataset.playerId = player.id;
    runner.textContent = RUNNER_EMOJIS[index % RUNNER_EMOJIS.length];

    const finish = document.createElement('div');
    finish.className = 'finish-line';

    line.append(runner, finish);
    row.append(head, line);
    track.appendChild(row);

    updateRunner(player.id);
  });
}

function updateRunner(racingPlayerId) {
  const row = document.querySelector(`.racer-row[data-player-id="${CSS.escape(racingPlayerId)}"]`);
  if (!row) return;

  const runner = row.querySelector('.runner');
  const progress = row.querySelector('.racer-progress');
  const position = positions.get(racingPlayerId) || 0;
  const percent = finishDistance > 0 ? position / finishDistance : 0;

  // Keep some space before the finish-line graphic.
  const visualPercent = Math.min(1, percent) * 88;
  runner.style.left = `${visualPercent}%`;
  progress.textContent = `${position}/${finishDistance}`;
}

function updateMyProgress() {
  $('myPosition').textContent = positions.get(playerId) || 0;
  $('myFinishDistance').textContent = finishDistance;
}

function leaveToHome() {
  if (isHost && roomId) {
    clearRetained(`${TOPIC_ROOT}/rooms/${roomId}/meta`);
    clearRetained(`${TOPIC_ROOT}/game/${roomId}/state`);
    clearRetained(`${TOPIC_ROOT}/game/${roomId}/players`);
    clearRetained(`${TOPIC_ROOT}/game/${roomId}/race/result`);
  }

  location.reload();
}

// Avoid leaving a stale public room in the retained room list when possible.
window.addEventListener('beforeunload', () => {
  if (isHost && roomId && mqttClient?.connected) {
    clearRetained(`${TOPIC_ROOT}/rooms/${roomId}/meta`);
  }
});

$('createRoomBtn').addEventListener('click', doCreateRoom);
$('joinRoomBtn').addEventListener('click', () => doJoinRoom());
$('refreshRoomsBtn').addEventListener('click', renderRoomList);
$('startGameBtn').addEventListener('click', hostStartGame);
$('runBtn').addEventListener('click', runOneStep);
$('backToHomeBtn').addEventListener('click', leaveToHome);

$('roomCodeInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') doJoinRoom();
});

connectMqtt();
roomListTimer = setInterval(() => {
  if (!screens.login.hidden) renderRoomList();
}, 1000);
