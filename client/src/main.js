// client/src/main.js
import { GameScene } from './scenes/GameScene.js';
import { UIScene }   from './scenes/UIScene.js';

const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  backgroundColor: '#0d0d0d',
  parent: 'game-container',
  scene: [GameScene, UIScene],
  pixelArt: true,
  dom: { createContainer: true },
  zoom: 1.5, // 放大整个游戏画面（内部坐标仍是 800×600，等比放大显示）
};

window.__phaserGame = new Phaser.Game(config);
