// client/src/entities/AgentNPC.js

// Fixed desk positions (up to 8 agents)
const DESK_POSITIONS = [
  { x: 150, y: 150 }, { x: 400, y: 150 }, { x: 650, y: 150 },
  { x: 150, y: 350 }, { x: 650, y: 350 },
  { x: 150, y: 500 }, { x: 400, y: 500 }, { x: 650, y: 500 },
];

export class AgentNPC {
  constructor(scene, agentConfig, posIndex) {
    const { x, y } = DESK_POSITIONS[posIndex % DESK_POSITIONS.length];
    this.scene = scene;
    this.config = agentConfig;
    this.homeX = x;
    this.homeY = y;

    // Desk (gray rectangle)
    scene.add.rectangle(x, y, 48, 36, 0x2a2a4e).setDepth(1);
    scene.add.rectangle(x, y, 46, 34, 0x1a1a3e).setDepth(2);

    // NPC sprite (colored rectangle placeholder)
    this.sprite = scene.add.rectangle(x, y - 28, 16, 16, 0x4a90e2).setDepth(5);

    // Emoji label
    this.emojiLabel = scene.add.text(x, y - 28, agentConfig.emoji || '🤖', {
      fontSize: '14px'
    }).setOrigin(0.5).setDepth(6);

    // Name label (custom name from config)
    this.nameLabel = scene.add.text(x, y + 24, agentConfig.name || agentConfig.id, {
      fontSize: '8px', color: '#aaaacc', fontFamily: 'monospace'
    }).setOrigin(0.5).setDepth(6);

    // Status indicator
    this.statusLabel = scene.add.text(x, y - 44, '', {
      fontSize: '8px', color: '#ffdd55', fontFamily: 'monospace'
    }).setOrigin(0.5).setDepth(6);

    // Chat bubble (hidden by default)
    this.bubbleBg   = scene.add.rectangle(x, y - 70, 120, 28, 0xffffff, 0.9).setDepth(7).setVisible(false);
    this.bubbleText = scene.add.text(x, y - 70, '', {
      fontSize: '7px', color: '#000000', fontFamily: 'monospace',
      wordWrap: { width: 110 }
    }).setOrigin(0.5).setDepth(8).setVisible(false);

    this.proximityRadius = 55;
    this.isPlayerNear = false;
    this.onPlayerEnter = null; // callback: (agentConfig) => void
  }

  checkProximity(playerX, playerY) {
    const dist = Phaser.Math.Distance.Between(playerX, playerY, this.homeX, this.homeY);
    const wasNear = this.isPlayerNear;
    this.isPlayerNear = dist < this.proximityRadius;
    if (!wasNear && this.isPlayerNear && this.onPlayerEnter) {
      this.onPlayerEnter(this.config);
    }
    // Highlight when player is near
    this.sprite.setStrokeStyle(this.isPlayerNear ? 2 : 0, 0xffffff);
  }

  setStatus(status, result) {
    const labels = { idle: '', working: '⚙ working...', done: '✅ done' };
    this.statusLabel.setText(labels[status] || '');
    if (status === 'done' && result) this.showBubble(result.slice(0, 60));
  }

  showBubble(text) {
    this.bubbleText.setText(text);
    this.bubbleBg.setVisible(true);
    this.bubbleText.setVisible(true);
    if (this._bubbleTimer) this._bubbleTimer.remove();
    this._bubbleTimer = this.scene.time.delayedCall(4000, () => {
      this.bubbleBg.setVisible(false);
      this.bubbleText.setVisible(false);
    });
  }

  moveTo(targetNPC) {
    this.scene.tweens.add({
      targets: [this.sprite, this.emojiLabel],
      x: targetNPC.homeX,
      y: targetNPC.homeY - 28,
      duration: 700,
      ease: 'Sine.easeInOut',
    });
  }

  returnHome() {
    this.scene.tweens.add({
      targets: [this.sprite, this.emojiLabel],
      x: this.homeX,
      y: this.homeY - 28,
      duration: 500,
      ease: 'Sine.easeInOut',
    });
  }

  destroy() {
    this.sprite.destroy();
    this.emojiLabel.destroy();
    this.nameLabel.destroy();
    this.statusLabel.destroy();
    this.bubbleBg.destroy();
    this.bubbleText.destroy();
  }
}
