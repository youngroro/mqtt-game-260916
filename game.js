'use strict';

// Pure frontend architecture:
// - No REST API / Node backend.
// - Every browser connects directly to an MQTT broker over secure WebSocket.
// - The room host is the authority for room state, mole spawning and scoring.

const MQTT_WS_URL = 'wss://broker.emqx.io:8084/mqtt';
const TOPIC_ROOT = 'whack-a-mole-gh-pages-v1';
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_STALE_MS = 15000;
const ROOM_HEARTBEAT_MS = 5000;
const MIN_SPAWN_DELAY_MS = 450;
const MAX_SPAWN_DELAY_MS = 1000;
const MIN_SHOW_TIME_MS = 700;
const MAX_SHOW_TIME_MS = 1400;

let playerId = createId();
let playerName = null;
let roomId = null;
let gridSize = 3;
let duration = 60;
let hostId = null;
let isHost = false;
let roomState = 'waiting';
let remaining = 0;

let mqttClient = null;
let roomHeartbeatTimer = null;
let roomListTimer = null;
let countdownTimer = null;
let spawnTimer = null;

const activeMoles = new Map();
const roomPlayers = new Map();
const latestScores = new Map();
const discoveredRooms = new Map();

const $ = (id) => document.getElementById(id);

const screens = {
  login: $('screen-login'),
  lobby: $('screen-lobby'),
  game: $('screen-game'),
  result: $('screen-result'),
};

function createId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min));
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

function setConnStatus(online) {
  const el = $('connStatus');
  el.textContent = online ? 'MQTT: 已連線' : 'MQTT: 連線中...';
  el.classList.toggle('online', online);
  el.classList.toggle('offline', !online);
}

function showLoginError(msg) {
  $('loginError').textContent = msg || '';
}

function getNickname() {
  const name = $('nicknameInput').value.trim();
  if (!name) {
    showLoginError('請先輸入暱稱');
    return null;
  }
  showLoginError('');
  return name;
}

function publish(topic, payload, options = {}) {
  if (!mqttClient?.connected) return;
  mqttClient.publish(topic, JSON.stringify(payload), {
    qos: 0,
    retain: Boolean(options.retain),
  });
}

function connectMqtt() {
  if (mqttClient) return;

  mqttClient = mqtt.connect(MQTT_WS_URL, {
    clientId: `web-${playerId}-${Math.random().toString(16).slice(2)}`,
    reconnectPeriod: 2000,
    clean: true,
  });

  mqttClient.on('connect', () => {
    setConnStatus(true);
    mqttClient.subscribe(`${TOPIC_ROOT}/rooms/+/meta`);
    if (roomId) subscribeRoom(roomId);
    renderRoomList();
  });

  mqttClient.on('reconnect', () => setConnStatus(false));
  mqttClient.on('close', () => setConnStatus(false));
  mqttClient.on('error', (err) => console.error('MQTT error', err));

  mqttClient.on('message', (topic, payloadBuf) => {
    let data;
    try {
      data = JSON.parse(payloadBuf.toString());
    } catch {
      return;
    }

    if (topic.startsWith(`${TOPIC_ROOT}/rooms/`) && topic.endsWith('/meta')) {
      handleRoomMeta(topic, data);
      return;
    }

    if (!roomId || !topic.startsWith(`${TOPIC_ROOT}/game/${roomId}/`)) return;
    const sub = topic.slice(`${TOPIC_ROOT}/game/${roomId}/`.length);
    handleRoomMessage(sub, data);
  });
}

function subscribeRoom(code) {
  mqttClient?.subscribe(`${TOPIC_ROOT}/game/${code}/#`);
}

function handleRoomMeta(topic, data) {
  const parts = topic.split('/');
  const code = parts[2];
  if (!code || !data) return;

  discoveredRooms.set(code, { ...data, roomId: code });
  renderRoomList();
}

function renderRoomList() {
  const list = $('roomList');
  if (!list) return;

  const now = Date.now();
  const rooms = [...discoveredRooms.values()]
    .filter((room) => room.state === 'waiting' && now - Number(room.updatedAt || 0) <= ROOM_STALE_MS)
    .sort((a, b) => String(a.roomId).localeCompare(String(b.roomId)));

  list.innerHTML = '';
  if (rooms.length === 0) {
    list.innerHTML = '<li>目前沒有房間，建立一個吧！</li>';
    return;
  }

  rooms.forEach((room) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `🏠 ${room.roomId}（${room.hostName || '房主'}）｜${room.gridSize}x${room.gridSize}｜${room.duration}s｜${room.playerCount || 1} 人`;

    const btn = document.createElement('button');
    btn.textContent = '加入';
    btn.className = 'secondary';
    btn.onclick = () => doJoinRoom(room.roomId);

    li.append(span, btn);
    list.appendChild(li);
  });
}

function doCreateRoom() {
  const name = getNickname();
  if (!name) return;
  if (!mqttClient?.connected) {
    showLoginError('MQTT 尚未連線，請稍後再試');
    return;
  }

  playerName = name;
  playerId = createId();
  roomId = generateRoomCode();
  gridSize = parseInt($('gridSizeSelect').value, 10) || 3;
  duration = parseInt($('durationSelect').value, 10) || 60;
  remaining = duration;
  hostId = playerId;
  isHost = true;
  roomState = 'waiting';

  roomPlayers.clear();
  latestScores.clear();
  roomPlayers.set(playerId, { id: playerId, name: playerName, score: 0 });

  subscribeRoom(roomId);
  enterLobby();
  publishHostSnapshot();
  startRoomHeartbeat();
}

function doJoinRoom(explicitRoomId) {
  const name = getNickname();
  if (!name) return;
  if (!mqttClient?.connected) {
    showLoginError('MQTT 尚未連線，請稍後再試');
    return;
  }

  const code = String(explicitRoomId || $('roomCodeInput').value).trim().toUpperCase();
  if (!code) {
    showLoginError('請輸入房間代碼');
    return;
  }

  const knownRoom = discoveredRooms.get(code);
  if (knownRoom && Date.now() - Number(knownRoom.updatedAt || 0) > ROOM_STALE_MS) {
    showLoginError('房間已離線或不存在');
    return;
  }

  playerName = name;
  playerId = createId();
  roomId = code;
  isHost = false;
  roomState = 'waiting';

  subscribeRoom(roomId);
  enterLobby();

  setTimeout(() => {
    publish(`${TOPIC_ROOT}/game/${roomId}/join/request`, {
      playerId,
      playerName,
      ts: Date.now(),
    });
  }, 150);

  setTimeout(() => {
    if (!roomPlayers.has(playerId) && roomState === 'waiting') {
      showLoginError('無法加入房間，房主可能已離線');
      showScreen('login');
      roomId = null;
    }
  }, 3000);
}

function enterLobby() {
  showScreen('lobby');
  $('lobbyRoomId').textContent = roomId;
  $('lobbyGridSize').textContent = `${gridSize} x ${gridSize}`;
  $('lobbyDuration').textContent = duration;
  $('startGameBtn').hidden = !isHost;
  $('lobbyWaitingMsg').hidden = isHost;
}

function handleRoomMessage(sub, data) {
  switch (sub) {
    case 'join/request':
      if (isHost) hostHandleJoin(data);
      break;
    case 'join/rejected':
      if (data.playerId === playerId) {
        showLoginError(data.message || '無法加入房間');
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
    case 'mole/spawn':
      onMoleSpawn(data);
      break;
    case 'mole/despawn':
      onMoleDespawn(data);
      break;
    case 'mole/hit':
      if (isHost) hostHandleHit(data);
      break;
    case 'score/update':
      onScoreUpdate(data.scores || []);
      break;
    case 'countdown':
      remaining = Number(data.remaining ?? remaining);
      $('timeRemaining').textContent = remaining;
      break;
    case 'result':
      onResult(data.leaderboard || []);
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
      message: '遊戲已開始，無法加入',
    });
    return;
  }

  if (!roomPlayers.has(joiningId)) {
    roomPlayers.set(joiningId, {
      id: joiningId,
      name: String(joiningName).trim().slice(0, 16) || '玩家',
      score: 0,
    });
  }

  publishPlayers();
  publishState();
  publishRoomMeta();
}

function publishHostSnapshot() {
  publishState();
  publishPlayers();
  publishRoomMeta();
}

function publishState() {
  if (!isHost) return;
  publish(`${TOPIC_ROOT}/game/${roomId}/state`, {
    state: roomState,
    roomId,
    gridSize,
    duration,
    remaining,
    hostId,
  }, { retain: true });
}

function publishPlayers() {
  if (!isHost) return;
  publish(`${TOPIC_ROOT}/game/${roomId}/players`, {
    players: [...roomPlayers.values()],
  }, { retain: true });
}

function publishScores() {
  if (!isHost) return;
  const scores = [...roomPlayers.values()]
    .map((p) => ({ playerId: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  publish(`${TOPIC_ROOT}/game/${roomId}/score/update`, { scores });
}

function publishRoomMeta() {
  if (!isHost || !roomId) return;
  publish(`${TOPIC_ROOT}/rooms/${roomId}/meta`, {
    hostId,
    hostName: roomPlayers.get(hostId)?.name || playerName,
    gridSize,
    duration,
    state: roomState,
    playerCount: roomPlayers.size,
    updatedAt: Date.now(),
  }, { retain: true });
}

function startRoomHeartbeat() {
  clearInterval(roomHeartbeatTimer);
  publishRoomMeta();
  roomHeartbeatTimer = setInterval(publishRoomMeta, ROOM_HEARTBEAT_MS);
}

function onStateUpdate(data) {
  if (!data) return;

  roomState = data.state || roomState;
  gridSize = Number(data.gridSize || gridSize);
  duration = Number(data.duration || duration);
  remaining = Number(data.remaining ?? remaining);
  hostId = data.hostId || hostId;
  isHost = hostId === playerId;

  $('lobbyGridSize').textContent = `${gridSize} x ${gridSize}`;
  $('lobbyDuration').textContent = duration;
  $('startGameBtn').hidden = !isHost;
  $('lobbyWaitingMsg').hidden = isHost;

  if (roomState === 'waiting') {
    activeMoles.clear();
    showScreen('lobby');
  } else if (roomState === 'playing') {
    startGameScreen(remaining);
  }
}

function onPlayersUpdate(players) {
  roomPlayers.clear();
  latestScores.clear();

  players.forEach((p) => {
    roomPlayers.set(p.id, { id: p.id, name: p.name, score: Number(p.score || 0) });
    latestScores.set(p.id, { name: p.name, score: Number(p.score || 0) });
  });

  const list = $('lobbyPlayers');
  list.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.id === hostId ? `👑 ${p.name}` : p.name;
    list.appendChild(li);
  });
}

function hostStartGame() {
  if (!isHost || roomState !== 'waiting') return;

  roomState = 'playing';
  remaining = duration;
  activeMoles.clear();

  for (const player of roomPlayers.values()) {
    player.score = 0;
  }

  publishState();
  publishPlayers();
  publishScores();
  publishRoomMeta();
  hostScheduleSpawn();

  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (roomState !== 'playing') return;
    remaining -= 1;
    publish(`${TOPIC_ROOT}/game/${roomId}/countdown`, { remaining });
    if (remaining <= 0) hostEndGame();
  }, 1000);
}

function hostScheduleSpawn() {
  if (!isHost || roomState !== 'playing') return;

  clearTimeout(spawnTimer);
  spawnTimer = setTimeout(() => {
    hostSpawnMole();
    hostScheduleSpawn();
  }, randomBetween(MIN_SPAWN_DELAY_MS, MAX_SPAWN_DELAY_MS));
}

function hostSpawnMole() {
  const totalHoles = gridSize * gridSize;
  const emptyHoles = [];
  for (let i = 0; i < totalHoles; i += 1) {
    if (!activeMoles.has(i)) emptyHoles.push(i);
  }
  if (emptyHoles.length === 0) return;

  const holeIndex = emptyHoles[Math.floor(Math.random() * emptyHoles.length)];
  const moleId = createId();
  const showTime = randomBetween(MIN_SHOW_TIME_MS, MAX_SHOW_TIME_MS);

  activeMoles.set(holeIndex, moleId);
  publish(`${TOPIC_ROOT}/game/${roomId}/mole/spawn`, { holeIndex, moleId, showTime });

  setTimeout(() => {
    if (!isHost || roomState !== 'playing') return;
    if (activeMoles.get(holeIndex) !== moleId) return;

    activeMoles.delete(holeIndex);
    publish(`${TOPIC_ROOT}/game/${roomId}/mole/despawn`, {
      holeIndex,
      moleId,
      reason: 'timeout',
    });
  }, showTime);
}

function hostHandleHit({ playerId: hitPlayerId, holeIndex, moleId } = {}) {
  if (!isHost || roomState !== 'playing') return;
  if (!Number.isInteger(holeIndex) || !moleId || !hitPlayerId) return;
  if (activeMoles.get(holeIndex) !== moleId) return;

  const player = roomPlayers.get(hitPlayerId);
  if (!player) return;

  activeMoles.delete(holeIndex);
  player.score += 1;

  publish(`${TOPIC_ROOT}/game/${roomId}/mole/despawn`, {
    holeIndex,
    moleId,
    reason: 'hit',
    playerId: hitPlayerId,
  });
  publishScores();
}

function hostEndGame() {
  if (!isHost || roomState === 'ended') return;

  roomState = 'ended';
  remaining = 0;
  clearInterval(countdownTimer);
  clearTimeout(spawnTimer);
  activeMoles.clear();

  const leaderboard = [...roomPlayers.values()]
    .map((p) => ({ playerId: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  publishState();
  publish(`${TOPIC_ROOT}/game/${roomId}/result`, { leaderboard }, { retain: true });
  publishRoomMeta();
}

function startGameScreen(seconds) {
  showScreen('game');
  $('timeRemaining').textContent = seconds;
  $('myScore').textContent = latestScores.get(playerId)?.score ?? 0;

  if ($('grid').children.length !== gridSize * gridSize) {
    buildGrid(gridSize);
  }
}

function buildGrid(size) {
  const grid = $('grid');
  grid.innerHTML = '';
  grid.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
  activeMoles.clear();

  for (let i = 0; i < size * size; i += 1) {
    const hole = document.createElement('div');
    hole.className = 'hole';
    hole.dataset.index = String(i);

    const mole = document.createElement('span');
    mole.className = 'mole';
    mole.textContent = '🐹';

    hole.appendChild(mole);
    hole.addEventListener('click', () => onHoleClick(i));
    grid.appendChild(hole);
  }
}

function getHoleEl(index) {
  return document.querySelector(`.hole[data-index="${index}"]`);
}

function onMoleSpawn({ holeIndex, moleId }) {
  activeMoles.set(holeIndex, moleId);
  const hole = getHoleEl(holeIndex);
  if (hole) {
    hole.classList.remove('hit');
    hole.classList.add('active');
  }
}

function onMoleDespawn({ holeIndex, moleId }) {
  if (activeMoles.get(holeIndex) !== moleId) return;
  activeMoles.delete(holeIndex);

  const hole = getHoleEl(holeIndex);
  if (hole) {
    hole.classList.remove('active');
    hole.classList.add('hit');
  }
}

function onHoleClick(holeIndex) {
  if (roomState !== 'playing') return;
  const moleId = activeMoles.get(holeIndex);
  if (!moleId) return;

  const hole = getHoleEl(holeIndex);
  if (hole) hole.classList.remove('active');

  publish(`${TOPIC_ROOT}/game/${roomId}/mole/hit`, {
    playerId,
    playerName,
    holeIndex,
    moleId,
    ts: Date.now(),
  });
}

function onScoreUpdate(scores) {
  latestScores.clear();
  scores.forEach((s) => {
    latestScores.set(s.playerId, { name: s.name, score: Number(s.score || 0) });
  });

  $('myScore').textContent = latestScores.get(playerId)?.score ?? 0;
  renderScoreboard($('scoreboard'), scores);
}

function renderScoreboard(el, scores) {
  el.innerHTML = '';
  scores.forEach((s) => {
    const li = document.createElement('li');
    li.textContent = `${s.name}：${s.score} 分`;
    if (s.playerId === playerId) li.classList.add('me');
    el.appendChild(li);
  });
}

function onResult(leaderboard) {
  roomState = 'ended';
  showScreen('result');
  renderScoreboard($('finalLeaderboard'), leaderboard);
}

function leaveRoomAndReload() {
  if (isHost && roomId) {
    publish(`${TOPIC_ROOT}/rooms/${roomId}/meta`, {
      hostId,
      hostName: playerName,
      gridSize,
      duration,
      state: 'ended',
      playerCount: roomPlayers.size,
      updatedAt: Date.now(),
    }, { retain: true });
  }
  location.reload();
}

$('createRoomBtn').addEventListener('click', doCreateRoom);
$('joinRoomBtn').addEventListener('click', () => doJoinRoom());
$('refreshRoomsBtn').addEventListener('click', renderRoomList);
$('startGameBtn').addEventListener('click', hostStartGame);
$('backToLobbyBtn').addEventListener('click', leaveRoomAndReload);

connectMqtt();
roomListTimer = setInterval(() => {
  if (!screens.login.hidden) renderRoomList();
}, 1000);
