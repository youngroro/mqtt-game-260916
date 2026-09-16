# MQTT 多人賽跑

純前端版本，可直接部署到 GitHub Pages。

## 檔案

- `index.html`
- `style.css`
- `game.js`

不需要：

- Docker
- Node.js backend
- npm build

## 執行方式

直接部署到 GitHub Pages 即可。

目前 MQTT Broker：

```text
wss://broker.emqx.io:8084/mqtt
```

## 遊戲設計

- MQTT：建立房間、加入房間、同步玩家、同步進度、公布結果。
- 玩家按「跑！」時，本機角色立即前進，不等待 MQTT round-trip。
- MQTT 傳的是最新絕對位置，例如 `position: 12`，不是單純 `+1`。
- 即使 QoS 0 偶爾掉一包，下一次訊息仍可把位置補到最新狀態。
- 房主負責確認第一個到終點的玩家並發布比賽結果。
