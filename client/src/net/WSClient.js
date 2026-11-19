// client/src/net/WSClient.js
export class WSClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.connect();
  }

  // Safe to call repeatedly: acts only once the previous socket has fully closed
  // (its 'disconnected' event has fired), and waits 3 seconds between attempts.
  connect() {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED || Date.now() < this.retryAt) return;
    this.retryAt = Date.now() + 3000;
    const ws = this.ws = new WebSocket(this.url);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      this.dispatchEvent(Object.assign(new Event(msg.type), { detail: msg }));
    };
    ws.onopen  = () => this.dispatchEvent(new Event('connected'));
    ws.onclose = () => this.dispatchEvent(new Event('disconnected'));
    ws.onerror = (e) => this.dispatchEvent(Object.assign(new Event('ws_error'), { detail: e }));
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }
}
