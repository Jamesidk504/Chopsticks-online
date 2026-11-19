// Minimal MQTT 3.1.1-over-WebSocket client. No SDK, accounts, API keys, or extra hosting.
// The public TBMQ demo is a sandbox, not a guaranteed production game server.
const BROKER = 'wss://demo.tbmq.io/mqtt';
const te = new TextEncoder();
const td = new TextDecoder();
const textBytes = value => {
  const b = te.encode(value);
  if (b.length > 65535) throw new Error('Message too long.');
  return Uint8Array.of(b.length >>> 8, b.length & 255, ...b);
};
function packet(header, bytes) {
  const rem = [];
  let size = bytes.length;
  do { let n = size % 128; size = Math.floor(size / 128); if (size) n |= 128; rem.push(n); } while (size);
  return Uint8Array.of(header, ...rem, ...bytes);
}
function append(...arrays) {
  const a = new Uint8Array(arrays.reduce((n,b)=>n+b.length,0));
  let offset=0; for (const b of arrays) {a.set(b,offset);offset+=b.length;}
  return a;
}
function parse(bytes, onPacket) {
  let offset=0;
  while(offset+2<=bytes.length) {
    const first=bytes[offset]; let size=0, shift=0, j=offset+1, used=0;
    while (j<bytes.length && used<4) {
      const b=bytes[j++];size+=(b&127)*2**shift;shift+=7;used++;
      if (!(b&128)) break;
    }
    if (!used || bytes[j-1]&128) break;
    if (size>1024*64) throw new Error('Relay packet too large.');
    if(j+size>bytes.length)break;
    onPacket(first,bytes.subarray(j,j+size));
    offset=j+size;
  }
  return bytes.subarray(offset);
}
export class Relay {
  constructor(code, clientId, onMessage, onStatus, options = {}) {
    if(!/^[A-F0-9]{12}$/.test(code)) throw new Error('Invalid room code.');
    this.topic=`chopsticks/arena/v5/${code}`;
    this.clientId=clientId;
    this.onMessage=onMessage;
    this.onStatus=onStatus;
    this.WS=options.WebSocket || WebSocket;
    this.url=options.url || BROKER;
    this.socket=null;this.ready=false;this.stopped=false;this.pending=new Uint8Array();
    this.connectTimer=null;this.retryTimer=null;this.pingTimer=null;
    this.start();
  }
  start() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.ready=false;this.pending=new Uint8Array();
    this.onStatus('connecting');
    const ws=new this.WS(this.url,'mqtt');this.socket=ws;ws.binaryType='arraybuffer';
    ws.onopen=()=>{
      if(this.socket!==ws||this.stopped)return;
      const vh=Uint8Array.of(0,4,77,81,84,84,4,0x82,0,30); // MQTT 3.1.1, clean session, username, 30s keepalive
      ws.send(packet(0x10,append(vh,textBytes(this.clientId),textBytes("demo"))));
    };
    ws.onmessage=event=>{
      if(this.socket!==ws||this.stopped)return;
      const payload=new Uint8Array(event.data);
      try {
        const input=append(this.pending,payload);
        this.pending=parse(input,(type,data)=>this.handle(type,data));
      } catch(e){ console.warn('Relay packet issue:',e);ws.close();}
    };
    ws.onerror=()=>{}; // On close gives actionable status.
    ws.onclose=()=>{
      if(this.socket!==ws||this.stopped)return;
      this.ready=false;this.onStatus('disconnected');
      clearInterval(this.pingTimer);clearTimeout(this.connectTimer);
      this.retryTimer=setTimeout(()=>this.start(),2500);
    };
    this.connectTimer=setTimeout(()=>{
      if(this.socket===ws&&!this.ready)ws.close();
    },14000);
  }
  handle(type,data) {
    const kind=type>>4;
    if(kind===2) { // CONNACK
      if(data.length<2||data[1]!==0){ this.socket.close();return; }
      const sub=append(Uint8Array.of(0,1),textBytes(this.topic),Uint8Array.of(0));
      this.socket.send(packet(0x82,sub));
    } else if(kind===9) { // SUBACK
      if(data.length<3||data[2]===0x80){this.socket.close();return;}
      this.ready=true;clearTimeout(this.connectTimer);
      this.onStatus('ready');
      clearInterval(this.pingTimer);
      this.pingTimer=setInterval(()=>{
        if(this.ready&&this.socket?.readyState===1)this.socket.send(Uint8Array.of(0xc0,0));
      },12000);
    } else if(kind===3) { // PUBLISH
      if(data.length<2)return;
      const n=(data[0]<<8)|data[1];if(2+n>data.length)return;
      const topic=td.decode(data.subarray(2,2+n));if(topic!==this.topic)return;
      let ptr=2+n;
      if((type&6)!==0){if(ptr+2>data.length)return;ptr+=2;}
      const bytes=data.subarray(ptr);
      if(bytes.length>4096)return;
      try {this.onMessage(JSON.parse(td.decode(bytes)));}catch(e){console.warn('Invalid room message',e);}
    }
  }
  send(value) {
    if(!this.ready||this.socket?.readyState!==1)return false;
    const msg=te.encode(JSON.stringify(value));
    if(msg.length>4096)return false;
    this.socket.send(packet(0x30,append(textBytes(this.topic),msg)));
    return true;
  }
  close() {
    this.stopped=true;this.ready=false;
    clearInterval(this.pingTimer);clearTimeout(this.retryTimer);clearTimeout(this.connectTimer);
    const ws=this.socket;this.socket=null;
    if(ws?.readyState===1){try{ws.send(Uint8Array.of(0xe0,0));}catch{}}
    try{ws?.close();}catch{}
  }
}
