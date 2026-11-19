import { startGame, legalSplits, applyMove } from './rules.mjs';
import { Relay } from './relay.mjs';

const $ = id => document.getElementById(id);
const randomHex = count => Array.from(crypto.getRandomValues(new Uint8Array(count)), b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
const app = {
  relay: null, code: '', me: randomHex(16), hostId: null, guestId: null,
  host: false, player: 0, phase: 'lobby', names: ['Host','Guest'],
  game: null, version: 0, selected: null, pending: null, requestSeq: 0,
  keepalive: null, lastContact: 0, toastTimer: null
};
const show = view => {
  for (const section of ['lobby','waiting','connecting','arena']) $(section).hidden = section !== view;
  window.scrollTo({top:0,behavior:'instant'});
};
function toast(msg,bad=false){
  const n=$('toast');n.textContent=msg;n.classList.toggle('bad',bad);n.hidden=false;
  clearTimeout(app.toastTimer);app.toastTimer=setTimeout(()=>n.hidden=true,5000);
}
function safeName(s){return String(s||'Player').trim().replace(/[<>\u0000-\u001F\u007F]/g,'').slice(0,18)||'Player';}
const username=()=>safeName($('nameInput').value);
function saveName(){try{localStorage.setItem('chopsticks-name',username())}catch{}}
function normalizeCode(s){
  let value=String(s||'').trim();
  try{if(/^https?:\/\//i.test(value))value=new URL(value).hash.replace(/^#room=/i,'');}catch{}
  return value.replace(/^#?room=/i,'').replace(/[-\s]/g,'').toUpperCase();
}
const inviteLink=()=>`${location.origin}${location.pathname}#room=${app.code}`;
function send(data){return app.relay?.send({...data,room:app.code,from:app.me,at:Date.now()})??false;}
function disconnect(){
  clearInterval(app.keepalive);app.keepalive=null;
  app.relay?.close();app.relay=null;
}
function home(){
  disconnect();app.game=null;app.code='';app.hostId=null;app.guestId=null;
  app.phase='lobby';app.pending=null;app.selected=null;
  history.replaceState(null,'',location.pathname);
  show('lobby');
}
function startRelay(){
  if(app.relay)app.relay.close();
  app.relay=new Relay(app.code,app.me,receive,onRelayStatus);
  clearInterval(app.keepalive);
  app.keepalive=setInterval(()=>{
    if(!app.relay?.ready)return;
    if(app.host){
      if(app.game)sendState();
      else send({type:'available'});
    } else if(!app.game){
      send({type:'join',name:username()});
    } else if(app.pending){
      send(app.pending.message);
    }
    if(!app.host&&app.lastContact&&Date.now()-app.lastContact>25000){
      if(app.phase==='connecting')$('connectStatus').textContent='Room not responding. Ask the host to keep their room open.';
      else if(app.phase==='game')$('moveHint').textContent='Connection to host lost. Waiting for room to return…';
    }
  },3000);
}
function createRoom(){
  if(app.phase!=='lobby')home();
  saveName();app.host=true;app.player=0;app.code=randomHex(6);
  app.hostId=app.me;app.guestId=null;app.game=null;app.version=0;app.requestSeq=0;
  app.names=[username(),'Guest'];app.phase='waiting';app.selected=null;app.pending=null;
  $('roomCode').textContent=app.code;
  $('waitingStatus').textContent='Connecting to shared game relay…';
  $('copyLinkBtn').disabled=true;$('copyCodeBtn').disabled=true;
  show('waiting');startRelay();
}
function joinRoom(input=$('joinInput').value){
  const code=normalizeCode(input);
  if(!/^[A-F0-9]{12}$/.test(code))return toast('Enter a valid 12-character room code.',true);
  saveName();disconnect();
  app.host=false;app.player=1;app.code=code;app.hostId=null;app.guestId=null;
  app.game=null;app.version=0;app.requestSeq=0;app.phase='connecting';app.pending=null;
  app.names=['Host',username()];app.selected=null;app.lastContact=0;
  $('connectStatus').textContent='Connecting to shared game relay…';
  show('connecting');startRelay();
}
function onRelayStatus(status){
  if(app.phase==='lobby')return;
  if(status==='ready'){
    if(app.host){
      if(app.phase==='waiting'){
        $('waitingStatus').textContent='● Room is live. Send your friend the invite link.';
        $('copyLinkBtn').disabled=false;$('copyCodeBtn').disabled=false;
      }
      if(app.game)sendState();else send({type:'available'});
    } else {
      if(app.phase==='connecting')$('connectStatus').textContent='● Relay connected. Looking for room '+app.code+'…';
      send({type:'join',name:username()});
    }
  } else if(status==='disconnected'){
    const msg='Relay disconnected. Reconnecting automatically…';
    if(app.host&&app.phase==='waiting'){$('waitingStatus').textContent=msg;$('copyLinkBtn').disabled=true;$('copyCodeBtn').disabled=true;}
    else if(app.phase==='connecting')$('connectStatus').textContent=msg;
    else if(app.phase==='game')toast(msg,true);
  } else if(status==='connecting'){
    if(app.host&&app.phase==='waiting')$('waitingStatus').textContent='Connecting to shared game relay…';
    else if(app.phase==='connecting')$('connectStatus').textContent='Connecting to shared game relay…';
  }
}
function validGame(g){
  return !!g&&Array.isArray(g.hands)&&g.hands.length===2&&
    g.hands.every(h=>Array.isArray(h)&&h.length===2&&h.every(n=>Number.isInteger(n)&&n>=0&&n<=4))&&
    [0,1,null].includes(g.turn)&&[0,1,null].includes(g.winner)&&Number.isInteger(g.moves)&&g.moves>=0;
}
function sendState(){
  if(!app.game||!app.guestId)return;
  send({type:'state',to:app.guestId,game:app.game,names:app.names,version:app.version});
}
function updateGame(newGame){
  app.game=newGame;app.version++;
  app.phase=newGame.winner===null?'game':'ended';app.selected=null;
  sendState();renderGame();
}
function receive(m){
  if(!m||typeof m!=='object'||m.room!==app.code||m.from===app.me||typeof m.from!=='string'||m.from.length>50)return;
  if(m.at&&Math.abs(Date.now()-m.at)>180000)return;
  if(app.host){
    if(m.type==='join'){
      if(app.guestId&&m.from!==app.guestId){send({type:'full',to:m.from});return;}
      if(!app.guestId&&app.phase==='waiting'){
        app.guestId=m.from;app.names[1]=safeName(m.name);app.game=startGame();app.version=1;app.phase='game';
        renderGame();
      }
      if(m.from===app.guestId)sendState();
    } else if(m.type==='move'&&m.from===app.guestId&&app.phase==='game'){
      if(!Number.isInteger(m.seq)||m.seq<=0||m.seq>999999||typeof m.move!=='object')return;
      if(m.seq<=app.requestSeq){sendState();return;}
      if(app.game?.turn!==1){sendState();return;}
      try{
        const next=applyMove(app.game,1,m.move);
        app.requestSeq=m.seq;updateGame(next);
      }catch{sendState();}
    } else if(m.type==='bye'&&m.from===app.guestId){
      app.phase='ended';app.guestId=null;
      endDisconnected();
    }
  } else {
    if(m.to&&m.to!==app.me)return;
    if(m.type==='state'&&validGame(m.game)&&Number.isSafeInteger(m.version)){
      if(app.hostId&&m.from!==app.hostId)return;
      if(!app.hostId)app.hostId=m.from;
      if(m.version<app.version)return;
      const advanced=m.version>app.version;
      app.lastContact=Date.now();
      app.version=m.version;app.game=m.game;
      app.names=Array.isArray(m.names)&&m.names.length===2?m.names.map(safeName):app.names;
      if(advanced)app.pending=null;
      app.phase=app.game.winner===null?'game':'ended';app.selected=null;
      renderGame();
    } else if(m.type==='full'){
      $('connectStatus').textContent='This room is full. Ask the host to create another one.';
    } else if(m.type==='bye'&&m.from===app.hostId){
      app.phase='ended';endDisconnected();
    }
  }
}
function endDisconnected(){
  if(!app.game)return home();
  show('arena');$('moveHint').textContent='Opponent left the room. Start a new room to play again.';
  $('resultArea').hidden=false;$('resultTitle').textContent='Opponent disconnected';
  $('resultCaption').textContent='The match ended. No records are saved.';
  $('rematchBtn').hidden=true;$('rematchHint').hidden=true;
  $('splitArea').hidden=true;
  document.querySelectorAll('#arena .hand').forEach(h=>h.disabled=true);
}
function chooseMove(move){
  if(app.phase!=='game'||!app.game||app.game.turn!==app.player||!app.relay?.ready||app.pending)return;
  try{
    if(app.host)updateGame(applyMove(app.game,0,move));
    else{
      applyMove(app.game,1,move); // verify locally; host will verify again
      app.requestSeq++;
      app.pending={message:{type:'move',seq:app.requestSeq,move},at:Date.now()};
      if(!send(app.pending.message))throw new Error('Relay is disconnected.');
      app.selected=null;renderGame();
    }
  }catch(e){app.pending=null;toast(e.message||'Illegal move.',true);}
}
function newHand(value,name,enemy,index){
  const btn=document.createElement('button');btn.type='button';
  const myTurn=app.phase==='game'&&app.game?.turn===app.player&&app.relay?.ready&&!app.pending;
  btn.disabled=(!enemy&&!myTurn)||(enemy&&(!myTurn||app.selected===null))||value===0;
  btn.className=`hand${enemy?' enemy':''}${value===0?' dead':''}${!enemy&&app.selected===index?' selected':''}`;
  btn.setAttribute('aria-label',`${name} hand: ${value===0?'out':`${value} fingers`}`);
  const fingers=document.createElement('div');fingers.className='fingers';
  for(let i=0;i<4;i++){const span=document.createElement('span');span.className=`finger${i<value?' on':''}`;fingers.append(span);}
  const num=document.createElement('div');num.className='number';num.textContent=value||'OUT';
  const small=document.createElement('small');small.textContent=name;
  btn.append(fingers,num,small);
  btn.addEventListener('click',()=>{
    if(enemy)chooseMove({type:'hit',from:app.selected,to:index});
    else{app.selected=app.selected===index?null:index;renderGame();}
  });
  return btn;
}
function renderGame(){
  const g=app.game;if(!g)return;show('arena');
  $('matchCode').textContent=`ROOM ${app.code}`;
  $('myName').textContent=app.names[app.player];
  $('opponentName').textContent=app.names[1-app.player];
  $('matchSubtitle').textContent=`${app.names[app.player]} vs ${app.names[1-app.player]}`;
  const me=g.hands[app.player],them=g.hands[1-app.player];
  $('myHands').replaceChildren(...me.map((n,i)=>newHand(n,i?'Right hand':'Left hand',false,i)));
  $('opponentHands').replaceChildren(...them.map((n,i)=>newHand(n,i?'Right hand':'Left hand',true,i)));
  const myTurn=g.turn===app.player&&app.phase==='game'&&!app.pending;
  $('turnLabel').textContent=app.phase==='ended'?'GAME OVER':app.pending?'SENDING MOVE…':myTurn?'● YOUR TURN':'● OPPONENT’S TURN';
  $('turnLabel').classList.toggle('theirs',!myTurn);
  $('splitArea').hidden=!myTurn;
  $('splits').replaceChildren();
  if(myTurn)for(const [left,right] of legalSplits(me)){
    const b=document.createElement('button');b.type='button';b.className='btn secondary';
    b.textContent=`${left} + ${right}`;b.addEventListener('click',()=>chooseMove({type:'split',left,right}));$('splits').append(b);
  }
  $('moveHint').textContent=app.phase==='ended'?'The match is over.':app.pending?'Waiting for the host to confirm your move…':
    !myTurn?`Waiting for ${app.names[1-app.player]}…`:app.selected===null?
      'Tap one of your living hands, then an opponent’s living hand.':`Selected ${app.selected?'right':'left'} hand. Tap an opponent’s hand.`;
  $('resultArea').hidden=app.phase!=='ended';
  if(app.phase==='ended'){
    const won=g.winner===app.player;
    $('resultTitle').textContent=won?'★ YOU WON!':'Good game!';
    $('resultCaption').textContent=won?'You eliminated both hands. Nice game!':`${app.names[1-app.player]} won this round.`;
    $('rematchBtn').hidden=!app.host;$('rematchHint').hidden=app.host;
  }
}
async function copyText(v){
  try{await navigator.clipboard.writeText(v);toast('Copied!');}
  catch{toast('Copy blocked. Select and copy the room code.',true);}
}
function leave(){
  if(app.phase==='game'||app.phase==='ended')send({type:'bye',to:app.host?app.guestId:app.hostId});
  home();
}
function rematch(){
  if(!app.host||!app.guestId||app.phase!=='ended'||!app.relay?.ready)return;
  updateGame(startGame());
}
$('createBtn').addEventListener('click',createRoom);
$('joinBtn').addEventListener('click',()=>joinRoom());
$('joinInput').addEventListener('keydown',e=>{if(e.key==='Enter')joinRoom();});
$('nameInput').addEventListener('keydown',e=>{if(e.key==='Enter')createRoom();});
$('homeBtn').addEventListener('click',()=>{if(app.phase==='lobby'||confirm('Leave your match?'))leave();});
$('leaveWaitingBtn').addEventListener('click',home);
$('cancelJoinBtn').addEventListener('click',home);
$('leaveGameBtn').addEventListener('click',()=>{if(confirm('Leave the match?'))leave();});
$('copyCodeBtn').addEventListener('click',()=>copyText(app.code));
$('copyLinkBtn').addEventListener('click',()=>copyText(inviteLink()));
$('rematchBtn').addEventListener('click',rematch);
try{$('nameInput').value=safeName(localStorage.getItem('chopsticks-name')||'Player');}catch{}
const invite=location.hash.match(/^#room=([A-F0-9]{12})$/i);
if(invite){$('joinInput').value=invite[1].toUpperCase();joinRoom(invite[1]);}
