// client/src/net/WSClient.js
export class WSClient extends EventTarget {
  constructor(url) {
    super();
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      this.dispatchEvent(Object.assign(new Event(msg.type), { detail: msg }));
    };
    this.ws.onopen  = () => this.dispatchEvent(new Event('connected'));
    this.ws.onclose = () => this.dispatchEvent(new Event('disconnected'));
    this.ws.onerror = (e) => this.dispatchEvent(Object.assign(new Event('ws_error'), { detail: e }));
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}
