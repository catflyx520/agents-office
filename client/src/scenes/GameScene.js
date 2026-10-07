// client/src/scenes/GameScene.js
import { Player }   from '../entities/Player.js';
import { AgentNPC } from '../entities/AgentNPC.js';
import { WSClient } from '../net/WSClient.js';

export class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
    this.npcs = {};
  }

  create() {
    this.add.rectangle(400, 300, 800, 600, 0x1a1a2e);
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x2a2a4e, 0.5);
    for (let x = 0; x <= 800; x += 32) grid.lineBetween(x, 0, x, 600);
    for (let y = 0; y <= 600; y += 32) grid.lineBetween(0, y, 800, y);

    this.player = new Player(this, 400, 300);

    this.ws = new WSClient('ws://localhost:3000');

    this.ws.addEventListener('agents_list', (e) => {
      this.buildNPCs(e.detail.agents);
      this.scene.get('UIScene')?.onAgentsList?.(e.detail.agents);
    });

    this.ws.addEventListener('agent_move', (e) => {
      const { agentId, toAgentId } = e.detail;
      const npc    = this.npcs[agentId];
      const target = this.npcs[toAgentId];
      if (npc && target) {
        if (toAgentId === agentId) npc.returnHome();
        else npc.moveTo(target);
      }
    });

    this.ws.addEventListener('agent_bubble', (e) => {
      this.npcs[e.detail.agentId]?.showBubble(e.detail.text);
    });

    this.ws.addEventListener('agent_status', (e) => {
      this.npcs[e.detail.agentId]?.setStatus(e.detail.status, e.detail.result);
    });

    // UIScene auto-starts (active: true in constructor) — no launch needed
  }

  buildNPCs(agents) {
    // Destroy existing NPCs
    Object.values(this.npcs).forEach(npc => npc.destroy());
    this.npcs = {};

    agents.forEach((agent, i) => {
      const npc = new AgentNPC(this, agent, i);
      npc.onPlayerEnter = (config) => {
        this.scene.get('UIScene')?.openChat?.(config);
      };
      this.npcs[agent.id] = npc;
    });
  }

  update(time, delta) {
    this.player.update(delta);
    Object.values(this.npcs).forEach(npc => {
      npc.checkProximity(this.player.x, this.player.y);
    });
  }
}
