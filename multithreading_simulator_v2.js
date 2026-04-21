const ST={N:'new',R:'ready',X:'running',W:'waiting',T:'terminated'};
const COLORS_MAP={T1:'#22c55e',T2:'#3b82f6',T3:'#a855f7',T4:'#f97316',T5:'#ec4899'};
const MODEL_DESC={
  'many-to-one':'Many-to-One: All user threads share a single kernel thread. Blocked thread = all blocked. No true parallelism.',
  'one-to-one':'One-to-One: Each user thread has its own kernel thread. True parallelism. Used by Linux/Windows.',
  'many-to-many':'Many-to-Many: User threads multiplex onto a kernel thread pool. Best of both worlds.'
};
const ALGO_DESC={fcfs:' | FCFS: threads run to completion in arrival order.',rr:' | Round Robin: each thread gets a fixed time quantum before preemption.'};

let S={
  running:false, tick:0, threads:[], kthreads:[],
  model:'many-to-one', algo:'fcfs', sync:'semaphore',
  interval:null, semCount:2, semMax:2,
  buffer:[], bufMax:6, prodCount:0,
  logs:[], ganttLog:[],
  rrQueue:[],      // circular ready queue for RR (thread ids in order)
  rrSlice:0,       // how many ticks current thread has run this quantum
  quantum:2,       // time quantum for RR
  currentRR:null,  // thread id currently running under RR
  fcfsQueue:[]     // FIFO order of ready threads for FCFS
};
let speed=2;

function getDelay(){return[0,1200,800,500,300,150][speed]}

function onSpeedChange(v){
  speed=+v;
  document.getElementById('speed-lbl').textContent=v+'x';
  if(S.running){clearInterval(S.interval);S.interval=setInterval(tick,getDelay())}
}

document.getElementById('model-sel').onchange=function(){S.model=this.value;if(!S.running)resetSim()};
document.getElementById('sync-sel').onchange=function(){S.sync=this.value;if(!S.running)resetSim()};
document.getElementById('algo-sel').onchange=function(){
  S.algo=this.value;
  document.getElementById('quantum-wrap').style.display=S.algo==='rr'?'flex':'none';
  document.getElementById('rr-chip').style.display=S.algo==='rr'?'':'none';
  if(!S.running)resetSim();
};
document.getElementById('quantum-input').onchange=function(){
  S.quantum=Math.max(1,+this.value||2);
  if(!S.running)resetSim();
};

function initState(){
  const n=5;
  S.threads=Array.from({length:n},(_,i)=>({
    id:'T'+(i+1), state:ST.N, burst:Math.floor(Math.random()*5)+3,
    done:0, kid:null, arrivalOrder:i
  }));
  const km={'many-to-one':1,'one-to-one':n,'many-to-many':3}[S.model];
  S.kthreads=Array.from({length:km},(_,i)=>({id:'K'+(i+1),busy:false,tid:null}));
  S.semCount=S.semMax;
  S.buffer=[]; S.prodCount=0;
  S.rrQueue=[]; S.rrSlice=0; S.currentRR=null;
  S.fcfsQueue=[];
  S.ganttLog=[];
  S.quantum=+document.getElementById('quantum-input').value||2;
}

function resetSim(){
  clearInterval(S.interval);
  S.running=false; S.tick=0; S.logs=[];
  document.getElementById('btn-start').textContent='Start';
  document.getElementById('btn-start').className='btn go';
  initState();
  renderAll();
  log('Simulator reset.','info');
  document.getElementById('mdesc').textContent=(MODEL_DESC[S.model]||'')+(ALGO_DESC[S.algo]||'');
  document.getElementById('algo-badge-wrap').innerHTML=`<span class="algo-badge">${S.algo==='fcfs'?'FCFS':'Round Robin (q='+S.quantum+')'}</span>`;
  document.getElementById('q-order-lbl').textContent=S.algo==='fcfs'?'(FIFO order)':'(circular)';
  renderGantt();
}

function toggleSim(){
  if(S.running){
    S.running=false;
    clearInterval(S.interval);
    document.getElementById('btn-start').textContent='Resume';
    document.getElementById('btn-start').className='btn';
    log('Simulation paused.','warn');
  } else {
    S.running=true;
    document.getElementById('btn-start').textContent='Pause';
    document.getElementById('btn-start').className='btn pause';
    if(S.tick===0){
      log('Simulation started — model: '+S.model+' | algo: '+S.algo.toUpperCase(),'ok');
      S.threads.forEach(t=>{ t.state=ST.R; });
      if(S.algo==='fcfs'){
        S.fcfsQueue=S.threads.map(t=>t.id);
      } else {
        S.rrQueue=S.threads.map(t=>t.id);
      }
    }
    S.interval=setInterval(tick,getDelay());
  }
  renderAll();
}

function tick(){
  S.tick++;
  if(S.algo==='fcfs') doFCFS();
  else doRR();
  updateSync();
  renderAll();
  updateStats();
}

// ---- FCFS scheduling ----
function doFCFS(){
  const {threads,kthreads,model}=S;

  // Advance running threads one step
  threads.filter(t=>t.state===ST.X).forEach(t=>{
    t.done++;
    S.ganttLog.push({id:t.id,tick:S.tick});
    if(t.done>=t.burst){
      t.state=ST.T;
      freeKernel(t);
      log(t.id+' completed execution → Terminated','ok');
      // Remove from fcfsQueue if still there
      S.fcfsQueue=S.fcfsQueue.filter(id=>id!==t.id);
    }
  });

  // Unblock some waiting threads (I/O done)
  threads.filter(t=>t.state===ST.W).forEach(t=>{
    if(Math.random()<0.3){
      t.state=ST.R;
      // Re-add to tail of FCFS queue
      if(!S.fcfsQueue.includes(t.id)) S.fcfsQueue.push(t.id);
      log(t.id+' woke up from I/O → moved to ready queue','info');
    }
  });

  // Randomly block a ready thread (I/O request) — not in many-to-one during run
  const readyList=threads.filter(t=>t.state===ST.R);
  if(readyList.length>1&&Math.random()<0.12){
    const victim=readyList[Math.floor(Math.random()*readyList.length)];
    victim.state=ST.W;
    S.fcfsQueue=S.fcfsQueue.filter(id=>id!==victim.id);
    freeKernel(victim);
    log(victim.id+' requested I/O → moved to waiting queue','warn');
  }

  // FCFS: schedule next in queue if CPU/kernel is free
  const runningCount=threads.filter(t=>t.state===ST.X).length;
  const maxConcurrent={'many-to-one':1,'one-to-one':5,'many-to-many':3}[model];

  if(runningCount<maxConcurrent){
    const freeSlots=maxConcurrent-runningCount;
    const freeKernels=kthreads.filter(k=>!k.busy);
    // Pick from front of FCFS queue
    for(let i=0;i<Math.min(freeSlots,freeKernels.length);i++){
      const nextId=S.fcfsQueue.find(id=>{
        const t=threads.find(t=>t.id===id);
        return t&&t.state===ST.R;
      });
      if(!nextId) break;
      const t=threads.find(t=>t.id===nextId);
      const k=freeKernels[i];
      if(t&&k){
        t.state=ST.X; t.kid=k.id;
        k.busy=true; k.tid=t.id;
        log(t.id+' started execution on '+k.id+' [FCFS]','sched');
      }
    }
  }

  respawnIfDone();
}

// ---- Round Robin scheduling ----
function doRR(){
  const {threads,kthreads,model}=S;
  const maxConcurrent={'many-to-one':1,'one-to-one':5,'many-to-many':3}[model];

  // Track running threads and advance them
  threads.filter(t=>t.state===ST.X).forEach(t=>{
    t.done++;
    S.ganttLog.push({id:t.id,tick:S.tick});
    if(t.done>=t.burst){
      t.state=ST.T;
      freeKernel(t);
      S.rrQueue=S.rrQueue.filter(id=>id!==t.id);
      if(S.currentRR===t.id) S.currentRR=null;
      S.rrSlice=0;
      log(t.id+' completed its burst → Terminated','ok');
    }
  });
  S.rrSlice++;

  // Unblock waiting threads
  threads.filter(t=>t.state===ST.W).forEach(t=>{
    if(Math.random()<0.3){
      t.state=ST.R;
      if(!S.rrQueue.includes(t.id)) S.rrQueue.push(t.id);
      log(t.id+' woke up → added to tail of RR queue','info');
    }
  });

  // Randomly block a ready thread
  const readyList=threads.filter(t=>t.state===ST.R&&t.id!==S.currentRR);
  if(readyList.length>0&&Math.random()<0.1){
    const victim=readyList[Math.floor(Math.random()*readyList.length)];
    victim.state=ST.W;
    S.rrQueue=S.rrQueue.filter(id=>id!==victim.id);
    freeKernel(victim);
    log(victim.id+' blocked on I/O → waiting queue','warn');
  }

  // Check if quantum expired for current running thread
  if(S.rrSlice>=S.quantum){
    const runningThreads=threads.filter(t=>t.state===ST.X);
    runningThreads.forEach(t=>{
      if(t.state===ST.X){
        t.state=ST.R;
        freeKernel(t);
        // Move to tail of RR queue (circular)
        S.rrQueue=S.rrQueue.filter(id=>id!==t.id);
        S.rrQueue.push(t.id);
        log(t.id+' preempted after quantum of '+S.quantum+' → back to ready queue','sched');
      }
    });
    S.rrSlice=0;
    S.currentRR=null;
  }

  // Schedule threads from front of circular RR queue
  const freeKernels=kthreads.filter(k=>!k.busy);
  const runningNow=threads.filter(t=>t.state===ST.X).length;
  const slots=maxConcurrent-runningNow;

  for(let i=0;i<Math.min(slots,freeKernels.length);i++){
    const nextId=S.rrQueue.find(id=>{
      const t=threads.find(t=>t.id===id);
      return t&&t.state===ST.R;
    });
    if(!nextId) break;
    const t=threads.find(t=>t.id===nextId);
    const k=freeKernels[i];
    if(t&&k){
      t.state=ST.X; t.kid=k.id;
      k.busy=true; k.tid=t.id;
      S.currentRR=t.id;
      log(t.id+' started time slice on '+k.id+' [RR, q='+S.quantum+']','sched');
    }
  }

  respawnIfDone();
}

function freeKernel(t){
  if(t.kid){
    const k=S.kthreads.find(k=>k.id===t.kid);
    if(k){k.busy=false;k.tid=null;}
    t.kid=null;
  }
}

function respawnIfDone(){
  const alive=S.threads.filter(t=>t.state!==ST.T);
  if(alive.length===0){
    log('All threads done. Respawning for continuous demo...','warn');
    S.threads.forEach(t=>{
      t.state=ST.R; t.done=0;
      t.burst=Math.floor(Math.random()*5)+3; t.kid=null;
    });
    S.kthreads.forEach(k=>{k.busy=false;k.tid=null;});
    S.rrSlice=0; S.currentRR=null;
    if(S.algo==='fcfs') S.fcfsQueue=S.threads.map(t=>t.id);
    else S.rrQueue=S.threads.map(t=>t.id);
  }
}

function updateSync(){
  if(S.sync==='semaphore'){
    const runCnt=S.threads.filter(t=>t.state===ST.X).length;
    S.semCount=Math.max(0,S.semMax-Math.min(runCnt,S.semMax));
  } else {
    if(S.buffer.length<S.bufMax&&Math.random()<0.4){
      const item=++S.prodCount%9+1;
      S.buffer.push(item);
      log('Producer added item '+item+' → buffer ['+S.buffer.length+'/'+S.bufMax+']','info');
    }
    if(S.buffer.length>0&&Math.random()<0.3){
      const v=S.buffer.shift();
      log('Consumer removed item '+v+' → buffer ['+S.buffer.length+'/'+S.bufMax+']','info');
    }
  }
}

function renderAll(){
  renderUserThreads();
  renderKernelThreads();
  renderMapping();
  renderCPU();
  renderQueues();
  renderSync();
  renderGantt();
}

function stClass(st){return{new:'sn',ready:'sr',running:'sR',waiting:'sw',terminated:'sT'}[st]||'sn'}

function renderUserThreads(){
  document.getElementById('user-threads').innerHTML=S.threads.map(t=>{
    const pct=Math.round((t.done/t.burst)*100);
    const w=Math.round((pct/100)*36);
    return`<div class="tnode ${stClass(t.state)}" title="${t.id}: ${t.state} (${t.done}/${t.burst})">
      <div class="tlbl">${t.id}</div>
      <div class="tst">${t.state.slice(0,3)}</div>
      ${t.state===ST.X?`<div class="tprog" style="width:${w}px"></div>`:''}
    </div>`;
  }).join('');
}

function renderKernelThreads(){
  document.getElementById('kernel-threads').innerHTML=S.kthreads.map(k=>`
    <div class="knode ${k.busy?'kb':''}" title="${k.id}${k.tid?' serving '+k.tid:''}">
      <div style="font-size:10px;font-weight:500">${k.id}</div>
      <div style="font-size:8px;opacity:.7">${k.tid||'idle'}</div>
    </div>`).join('');
}

function renderMapping(){
  const svg=document.getElementById('map-svg');
  const W=svg.clientWidth||600;
  const uw=S.threads.length, kw=S.kthreads.length;
  const uSp=W/(uw+1), kSp=W/(kw+1);
  const uy=30, ky=110;
  let out='';
  S.threads.forEach((t,i)=>{
    if(t.kid){
      const ki=S.kthreads.findIndex(k=>k.id===t.kid);
      if(ki>=0){
        const x1=(i+1)*uSp, x2=(ki+1)*kSp;
        const col=t.state===ST.X?'#22c55e':t.state===ST.W?'#ef4444':'#3b82f6';
        out+=`<line x1="${x1}" y1="${uy+14}" x2="${x2}" y2="${ky-14}" stroke="${col}" stroke-width="2.5" stroke-dasharray="${t.state===ST.X?'0':'6 4'}" opacity=".8"/>`;
      }
    }
  });
  S.threads.forEach((t,i)=>{
    const x=(i+1)*uSp;
    const col={new:'#6b7280',ready:'#22c55e',running:'#22c55e',waiting:'#ef4444',terminated:'#374151'}[t.state];
    out+=`<circle cx="${x}" cy="${uy}" r="14" fill="${col}" opacity=".9"/>
    <text x="${x}" y="${uy+5}" text-anchor="middle" font-size="12" fill="#000" font-weight="700">${t.id}</text>`;
  });
  S.kthreads.forEach((k,i)=>{
    const x=(i+1)*kSp;
    const col=k.busy?'#3b82f6':'#374151';
    out+=`<circle cx="${x}" cy="${ky}" r="14" fill="${col}" opacity=".9"/>
    <text x="${x}" y="${ky+5}" text-anchor="middle" font-size="12" fill="${k.busy?'#000':'#9ca3af'}" font-weight="700">${k.id}</text>`;
  });
  svg.innerHTML=out;
}

function renderCPU(){
  const running=S.threads.filter(t=>t.state===ST.X);
  const el=document.getElementById('cpu-disp');
  if(!running.length){el.innerHTML='<div style="color:var(--muted);font-size:11px">CPU idle</div>';return;}
  el.innerHTML=running.map(t=>{
    const pct=Math.round((t.done/t.burst)*100);
    const sliceInfo=S.algo==='rr'?' | slice '+S.rrSlice+'/'+S.quantum:'';
    return`<div class="cpu-row">
      <div class="dot"></div>
      <span style="font-size:11px">${t.id} → ${t.kid||'?'}</span>
      <span style="font-size:10px;color:var(--muted);margin-left:auto">${pct}%${sliceInfo}</span>
    </div>`;
  }).join('');
}

function renderQueues(){
  const rq=S.threads.filter(t=>t.state===ST.R);
  const wq=S.threads.filter(t=>t.state===ST.W);
  // Show queue in scheduled order
  const orderedRQ=S.algo==='fcfs'
    ? S.fcfsQueue.map(id=>rq.find(t=>t.id===id)).filter(Boolean)
    : S.rrQueue.map(id=>rq.find(t=>t.id===id)).filter(Boolean);
  document.getElementById('ready-queue').innerHTML=
    orderedRQ.map(t=>`<div class="qi qr">${t.id}</div>`).join('')||
    '<span style="font-size:10px;color:var(--muted)">empty</span>';
  document.getElementById('wait-queue').innerHTML=
    wq.map(t=>`<div class="qi qw">${t.id}</div>`).join('')||
    '<span style="font-size:10px;color:var(--muted)">empty</span>';
}

function renderSync(){
  const el=document.getElementById('sync-content');
  const title=document.getElementById('sync-title');
  if(S.sync==='semaphore'){
    title.textContent='Semaphore';
    const pct=Math.round((S.semCount/S.semMax)*100);
    const wq=S.threads.filter(t=>t.state===ST.W);
    el.innerHTML=`<div style="font-size:11px;color:var(--muted);margin-bottom:4px">Slots available: <span style="color:var(--purple);font-weight:500">${S.semCount}/${S.semMax}</span></div>
    <div class="sem-bar"><div class="sem-fill" style="width:${pct}%"></div></div>
    <div style="font-size:10px;color:var(--muted);margin-top:5px">Blocked:</div>
    <div class="qrow" style="margin-top:3px">${wq.map(t=>`<div class="qi qw">${t.id}</div>`).join('')||'<span style="font-size:10px;color:var(--muted)">none</span>'}</div>`;
  } else {
    title.textContent='Monitor (Producer-Consumer)';
    const cells=Array.from({length:S.bufMax},(_,i)=>
      i<S.buffer.length?`<div class="bc bf">${S.buffer[i]}</div>`:`<div class="bc be"></div>`).join('');
    const pct=Math.round((S.buffer.length/S.bufMax)*100);
    el.innerHTML=`<div style="font-size:11px;color:var(--muted);margin-bottom:3px">Buffer: <span style="color:var(--teal);font-weight:500">${S.buffer.length}/${S.bufMax}</span></div>
    <div class="buf-row">${cells}</div>
    <div class="sem-bar"><div class="sem-fill" style="width:${pct}%;background:var(--teal)"></div></div>
    <div style="display:flex;gap:10px;margin-top:4px;font-size:10px">
      <div style="color:var(--muted)">Producer: <span style="color:var(--green);font-weight:500">${S.buffer.length<S.bufMax?'active':'blocked'}</span></div>
      <div style="color:var(--muted)">Consumer: <span style="color:var(--orange);font-weight:500">${S.buffer.length>0?'active':'blocked'}</span></div>
    </div>`;
  }
}

// ---- Gantt Chart ----
function renderGantt(){
  const svg=document.getElementById('gantt-svg');
  const CELL=24, ROW=24, PADY=10, PADX=44, LABELS_W=36;
  const tids=['T1','T2','T3','T4','T5'];
  const maxTick=Math.max(S.tick,25);
  const W=Math.max(1000,PADX+LABELS_W+maxTick*CELL+20);
  const H=PADY+tids.length*(ROW+6)+PADY+20;
  svg.setAttribute('width',W);
  svg.setAttribute('height',H);

  let out='';
  // Background grid columns
  for(let t=0;t<=maxTick;t++){
    const x=PADX+LABELS_W+t*CELL;
    out+=`<line x1="${x}" y1="${PADY}" x2="${x}" y2="${H-20}" stroke="#2d3250" stroke-width="1"/>`;
    if(t%5===0) out+=`<text x="${x}" y="${H-5}" text-anchor="middle" font-size="12" fill="#8890b0" font-weight="500">${t}</text>`;
  }

  // Render each thread row
  tids.forEach((tid,row)=>{
    const y=PADY+row*(ROW+6);
    // Label
    out+=`<text x="${PADX+LABELS_W-8}" y="${y+ROW/2+4}" text-anchor="end" font-size="14" fill="${COLORS_MAP[tid]||'#8890b0'}" font-weight="700">${tid}</text>`;
    // Execution blocks from ganttLog
    const ticks=S.ganttLog.filter(e=>e.id===tid);
    // Group consecutive ticks into segments
    let segs=[];
    ticks.forEach(e=>{
      const last=segs[segs.length-1];
      if(last&&e.tick===last.end+1) last.end=e.tick;
      else segs.push({start:e.tick,end:e.tick});
    });
    segs.forEach(seg=>{
      const x=PADX+LABELS_W+seg.start*CELL;
      const w=(seg.end-seg.start+1)*CELL;
      out+=`<rect x="${x}" y="${y+1}" width="${w}" height="${ROW-2}" rx="4" fill="${COLORS_MAP[tid]||'#22c55e'}" opacity=".85"/>`;
    });
    // Row separator
    out+=`<line x1="${PADX}" y1="${y+ROW+3}" x2="${PADX+LABELS_W+maxTick*CELL}" y2="${y+ROW+3}" stroke="#2d3250" stroke-width="1"/>`;
  });

  // Current tick marker
  const cx=PADX+LABELS_W+S.tick*CELL;
  out+=`<line x1="${cx}" y1="${PADY}" x2="${cx}" y2="${H-20}" stroke="#ef4444" stroke-width="2" opacity=".8"/>`;

  svg.innerHTML=out;
}

function updateStats(){
  document.getElementById('s-tick').textContent=S.tick;
  document.getElementById('s-run').textContent=S.threads.filter(t=>t.state===ST.X).length;
  document.getElementById('s-rdy').textContent=S.threads.filter(t=>t.state===ST.R).length;
  document.getElementById('s-wait').textContent=S.threads.filter(t=>t.state===ST.W).length;
  document.getElementById('s-done').textContent=S.threads.filter(t=>t.state===ST.T).length;
  if(S.algo==='rr') document.getElementById('s-slice').textContent=S.rrSlice+'/'+S.quantum;
}

function log(msg,type=''){
  const t=String(Math.floor(S.tick/10)).padStart(2,'0')+':'+String(S.tick%10*10).padStart(2,'0');
  S.logs.unshift({t,msg,type});
  if(S.logs.length>100) S.logs.pop();
  document.getElementById('log-panel').innerHTML=
    S.logs.map(l=>`<div class="le"><span class="lt">${l.t}</span><span class="lm ${l.type}">${l.msg}</span></div>`).join('');
}

resetSim();
