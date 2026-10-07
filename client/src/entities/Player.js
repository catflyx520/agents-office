// client/src/entities/Player.js
export class Player {
  constructor(scene, x, y) {
    this.scene = scene;
    // 彩色矩形占位（后续替换为 sprite）
    this.sprite = scene.add.rectangle(x, y, 16, 16, 0x00ff88).setDepth(10);
    this.nameLabel = scene.add.text(x, y - 16, '你', {
      fontSize: '8px', color: '#00ff88', fontFamily: 'monospace'
    }).setOrigin(0.5).setDepth(11);

    this.speed = 120;
    this.cursors = scene.input.keyboard.createCursorKeys();
    this.wasd = scene.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.W,
      down:  Phaser.Input.Keyboard.KeyCodes.S,
      left:  Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
  }

  update(delta) {
    const speed = this.speed * (delta / 1000);
    let dx = 0, dy = 0;

    if (this.cursors.left.isDown  || this.wasd.left.isDown)  dx -= speed;
    if (this.cursors.right.isDown || this.wasd.right.isDown) dx += speed;
    if (this.cursors.up.isDown    || this.wasd.up.isDown)    dy -= speed;
    if (this.cursors.down.isDown  || this.wasd.down.isDown)  dy += speed;

    this.sprite.x += dx;
    this.sprite.y += dy;
    this.nameLabel.x = this.sprite.x;
    this.nameLabel.y = this.sprite.y - 16;

    // 边界限制（800x600 地图）
    this.sprite.x = Phaser.Math.Clamp(this.sprite.x, 16, 784);
    this.sprite.y = Phaser.Math.Clamp(this.sprite.y, 16, 584);
  }

  get x() { return this.sprite.x; }
  get y() { return this.sprite.y; }
}
