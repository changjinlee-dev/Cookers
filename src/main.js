// Let Vite bundle styles (fixes GitHub Pages paths)
import "./style.css";

// Firebase (ESM CDN)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  getFirestore, collection, addDoc, doc, getDocs, onSnapshot,
  updateDoc, serverTimestamp, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

/* --------- Firebase config from env (injected by GitHub Actions) --------- */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

async function init() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  await signInAnonymously(auth);

  /* -----------------  UI refs  ----------------- */
  const hostBtn = document.getElementById("hostBtn");
  const joinBtn = document.getElementById("joinBtn");
  const hostPanel = document.getElementById("hostPanel");
  const joinPanel = document.getElementById("joinPanel");
  const roomsList = document.getElementById("roomsList");
  const roomPane = document.getElementById("roomPane");
  const roomTitle = document.getElementById("roomTitle");
  const maxPlayers = document.getElementById("maxPlayers");
  const hostQuestions = document.getElementById("hostQuestions");
  const createRoomBtn = document.getElementById("createRoom");

  hostBtn.onclick = () => { hostPanel.classList.remove("hidden"); joinPanel.classList.add("hidden"); };
  joinBtn.onclick = () => { hostPanel.classList.add("hidden"); joinPanel.classList.remove("hidden"); refreshRooms(); };

  /* ----------------- helpers ----------------- */
  const uid = () => auth.currentUser?.uid;
  const ABL = ["A","B","C","D"];

  function el(tag, attrs={}, children=[]){
    const e=document.createElement(tag);
    for(const [k,v] of Object.entries(attrs)){
      if(k==="class") e.className=v; else if(k==="text") e.textContent=v; else e.setAttribute(k,v);
    }
    (children||[]).forEach(c=>e.appendChild(c)); return e;
  }

  function parseQuestions(text){
    const blocks = text.split(/\n\s*\n/).map(b=>b.trim()).filter(Boolean);
    const out=[];
    for(const b of blocks){
      const lines=b.split(/\n/).map(l=>l.trim()).filter(Boolean);
      if(lines.length<6) continue;
      const q = lines[0].replace(/^\d+\.?\s*/, "");
      const opts=[];
      for(const L of ABL){
        const ln = lines.find(x=>new RegExp(`^${L}[)\\.]\\s*`,"i").test(x))||"";
        opts.push(ln.replace(/^[A-Da-d][)\\.]\\s*/, "").trim());
      }
      const ansLine = lines.find(l=>/^answer\s*:/i.test(l))||"";
      const letter = (ansLine.match(/[A-D]/i)||[null])[0];
      const explanation = (lines.find(l=>/^explanation\s*:/i.test(l))||"").replace(/^explanation\s*:\s*/i,"");
      if(!letter) continue;
      out.push({ q, options:opts, answer:{A:0,B:1,C:2,D:3}[letter.toUpperCase()], explanation });
    }
    return out;
  }

  async function loadQuestions(roomId){
    const qSnap = await getDocs(query(collection(doc(db,"rooms",roomId),"questions"), orderBy("index")));
    return qSnap.docs.map(d=>({id:d.id, ...d.data()})).sort((a,b)=>a.index-b.index);
  }

  /* -----------------  Create room (host)  ----------------- */
  createRoomBtn.onclick = async ()=>{
    const title = (roomTitle.value.trim()||"Quiz Room");
    const max = Math.max(1, parseInt(maxPlayers.value||"0",10));
    const parsed = parseQuestions(hostQuestions.value);
    if(!max){ alert("Enter participant count"); return; }
    if(parsed.length===0){ alert("Paste questions first"); return; }

    const roomRef = await addDoc(collection(db,"rooms"),{
      title, maxParticipants:max, participants:{}, status:"lobby",
      currentIndex:0, answers:{}, nextAcks:{}, createdAt: serverTimestamp()
    });

    await Promise.all(parsed.map((q,i)=> addDoc(collection(roomRef,"questions"), {index:i, ...q})));
    await updateDoc(roomRef, { [`participants.${uid()}`]: true }); // host counts as joined

    openRoom(roomRef.id, true);
    roomTitle.value=""; maxPlayers.value=""; hostQuestions.value="";
  };

  /* -----------------  Lobby list  ----------------- */
  async function refreshRooms(){
    roomsList.innerHTML = '<div class="muted">Loading…</div>';
    const roomsQ = query(collection(db,"rooms"), orderBy("createdAt"));
    const snap = await getDocs(roomsQ);
    roomsList.innerHTML = "";
    const rooms = snap.docs.map(d=>({id:d.id,...d.data()}))
      .filter(r=>["lobby","in_progress","countdown","question","reveal","wait_more"].includes(r.status));
    if(!rooms.length){ roomsList.innerHTML='<div class="muted">No public rooms yet.</div>'; return; }
    rooms.forEach(r=>{
      const joined = r.participants ? Object.keys(r.participants).length : 0;
      const row = el("div",{class:"item"});
      row.appendChild(el("div",{},[
        el("div",{text:r.title||"Room"}),
        el("div",{class:"muted",text:`${r.status} · ${joined}/${r.maxParticipants} joined`})
      ]));
      const btn = el("button",{class:"btn",text:"Join"});
      btn.onclick = ()=> joinRoom(r.id);
      row.appendChild(btn);
      roomsList.appendChild(row);
    });
  }

  async function joinRoom(roomId){
    const roomRef = doc(db,"rooms",roomId);
    await updateDoc(roomRef,{ [`participants.${uid()}`]: true });
    openRoom(roomId,false);
  }

  /* -----------------  Room realtime  ----------------- */
  let unsubRoom = null;
  async function openRoom(roomId, iAmHost){
    if(unsubRoom) unsubRoom(); roomPane.innerHTML='<div class="center">Loading room…</div>';
    const roomRef = doc(db,"rooms",roomId);
    const qs = await loadQuestions(roomId);

    unsubRoom = onSnapshot(roomRef, async (snap)=>{
      if(!snap.exists()){ roomPane.innerHTML='<div class="center">Room not found</div>'; return; }
      const room = {id: roomId, ...snap.data()};
      renderRoom(roomRef, room, qs, iAmHost);
    });
  }

  async function submitAnswer(roomRef, room, choice){
    if(room.status!=="question") return;
    await updateDoc(roomRef,{ [`answers.${uid()}`]: { choice, at: Date.now() } });
  }

  async function ackNext(roomRef){
    await updateDoc(roomRef,{ [`nextAcks.${uid()}`]: true });
  }

  async function maybeStartCountdown(roomRef, room, iAmHost){
    if(!iAmHost || room.status!=="lobby") return;
    const total = Object.keys(room.participants||{}).length;
    if(total >= (room.maxParticipants||1)){
      await updateDoc(roomRef,{ status:"countdown", countdownEndsAt: Date.now()+3000 });
    }
  }

  async function maybeOpenQuestion(roomRef, room, iAmHost){
    if(!iAmHost || room.status!=="countdown") return;
    if(Date.now() >= (room.countdownEndsAt||0)){
      await updateDoc(roomRef,{ status:"question", answers:{}, nextAcks:{} });
    }
  }

  async function maybeReveal(roomRef, room){
    if(room.status!=="question") return;
    const total = Object.keys(room.participants||{}).length;
    const answered = Object.keys(room.answers||{}).length;
    if(total>0 && answered>=total){
      await updateDoc(roomRef,{ status:"reveal" });
    }
  }

  async function maybeAdvance(roomRef, room, qsLen){
    if(room.status!=="reveal") return;
    const total = Object.keys(room.participants||{}).length;
    const acks  = Object.keys(room.nextAcks||{}).length;
    if(acks>=total){
      const next = room.currentIndex + 1;
      if(next >= qsLen){
        await updateDoc(roomRef,{ status:"wait_more", answers:{}, nextAcks:{} });
      } else {
        await updateDoc(roomRef,{ status:"question", currentIndex: next, answers:{}, nextAcks:{} });
      }
    }
  }

  async function hostAddMore(roomRef, txt){
    const extra = parseQuestions(txt);
    if(!extra.length){ alert("Nothing parsed"); return; }
    const qcol = collection(roomRef,"questions");
    const base = Date.now();
    await Promise.all(extra.map((q,i)=> addDoc(qcol,{ index: base+i, ...q })));
    await updateDoc(roomRef,{ status:"question", answers:{}, nextAcks:{} });
  }

  function renderRoom(roomRef, room, qs, iAmHost){
    roomPane.innerHTML='';
    const joined = room.participants ? Object.keys(room.participants).length : 0;

    const header = el("div",{class:"row"});
    header.appendChild(el("div",{class:"muted",text:`${room.title||"Room"} · ${joined}/${room.maxParticipants} players`}));
    const leave = el("button",{class:"btn bad",text:"Leave"});
    leave.onclick=()=>{ if(unsubRoom) unsubRoom(); roomPane.innerHTML='<div class="center">Left room.</div>'; };
    header.appendChild(leave);
    roomPane.appendChild(header);

    // host auto transitions
    maybeStartCountdown(roomRef, room, iAmHost);
    maybeOpenQuestion(roomRef, room, iAmHost);

    if(room.status==="lobby"){
      roomPane.appendChild(el("div",{class:"center",text:`Waiting for players ${joined}/${room.maxParticipants}…`}));
      return;
    }

    if(room.status==="countdown"){
      const t=(room.countdownEndsAt||Date.now());
      const wrap = el("div",{class:"center"});
      const span = el("div",{class:"count",text:"3"});
      wrap.appendChild(span); roomPane.appendChild(wrap);
      const timer=setInterval(()=>{
        const left = Math.ceil((t - Date.now())/1000);
        span.textContent = left>0 ? left : "Go!";
        if(Date.now() >= t) clearInterval(timer);
      },200);
      return;
    }

    const q = qs.find(x=>x.index===room.currentIndex);
    if(!q){ roomPane.appendChild(el("div",{class:"center",text:"Waiting for first question…"})); return; }

    const inReveal = room.status==="reveal";
    const myAns = room.answers?.[uid()]?.choice ?? null;

    const qbox = el("div",{class:"qbox"});
    qbox.appendChild(el("div",{class:"muted",text:`Question ${qs.findIndex(x=>x.index===q.index)+1}`}));
    qbox.appendChild(el("div",{style:"font-size:20px;margin:6px 0 10px 0;font-weight:700",text:q.q}));

    const ABL = ["A","B","C","D"];
    const answers = el("div",{class:"answers"});
    q.options.forEach((opt,i)=>{
      const b = el("button",{class:"ans",text:`${ABL[i]}. ${opt}`});
      b.disabled = inReveal || myAns!==null;
      b.onclick = ()=> submitAnswer(roomRef, room, i);
      if(inReveal){ if(i===q.answer) b.classList.add("correct"); if(i===myAns && myAns!==q.answer) b.classList.add("wrong"); }
      answers.appendChild(b);
    });
    qbox.appendChild(answers);

    const answered = Object.keys(room.answers||{}).length;
    qbox.appendChild(el("div",{class:"muted",text:`Answered: ${answered}/${joined}`}));

    if(inReveal){
      qbox.appendChild(el("div",{style:"height:8px"}));
      qbox.appendChild(el("div",{class:"muted",text:`Correct: ${ABL[q.answer]}. ${q.options[q.answer]}`}));
      if(q.explanation) qbox.appendChild(el("div",{style:"margin-top:6px",text:`Explanation: ${q.explanation}`}));
      const nextBtn = el("button",{class:"btn primary",text:"Next"}); nextBtn.style.marginTop="10px";
      nextBtn.onclick = ()=> ackNext(roomRef);
      qbox.appendChild(nextBtn);
      maybeAdvance(roomRef, room, qs.length);
    } else {
      maybeReveal(roomRef, room);
    }

    if(room.status==="wait_more"){
      if(iAmHost){
        const box = el("div",{class:"stack"}); box.style.marginTop="10px";
        const ta = el("textarea"); ta.placeholder="Provide more questions (same format)…";
        const add = el("button",{class:"btn ok",text:"Add & Continue"});
        add.onclick = ()=> hostAddMore(roomRef, ta.value);
        box.appendChild(ta); box.appendChild(add); roomPane.appendChild(box);
      } else {
        roomPane.appendChild(el("div",{class:"center",text:"Waiting for more questions from the host…"}));
      }
    }

    roomPane.appendChild(qbox);
  }

  // load lobby on startup
  refreshRooms();
}

init();
