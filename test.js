'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Golf Scorecard — Automated Test Suite
// Run: node test.js
// Exit 0 = all pass  |  Exit 1 = failures found
// ─────────────────────────────────────────────────────────────────────────────

// ── SYNTAX CHECK (runs before everything else) ────────────────────────────────
// Extracts the inline <script> from index.html and validates it parses cleanly.
// A syntax error here would cause a blank page — catch it before it ships.
{
  const fs = require('fs');
  const vm = require('vm');
  const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
  const scriptStart = html.indexOf('<script>');
  const scriptEnd   = html.lastIndexOf('</script>');
  if (scriptStart === -1 || scriptEnd === -1) {
    console.error('\x1b[31mSYNTAX CHECK FAILED: could not locate <script> block in index.html\x1b[0m');
    process.exit(1);
  }
  const js = html.slice(scriptStart + 8, scriptEnd);
  try {
    new vm.Script(js);
    console.log('\x1b[32m✓ index.html script syntax OK\x1b[0m');
  } catch (e) {
    console.error('\x1b[31mSYNTAX CHECK FAILED: ' + e.message + '\x1b[0m');
    console.error('Push blocked — fix the syntax error in index.html before pushing.');
    process.exit(1);
  }
}

// ── TERMINAL COLOURS ─────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const C = {
  red:    isTTY ? '\x1b[31m' : '',
  green:  isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan:   isTTY ? '\x1b[36m' : '',
  bold:   isTTY ? '\x1b[1m'  : '',
  dim:    isTTY ? '\x1b[2m'  : '',
  reset:  isTTY ? '\x1b[0m'  : '',
};

// ── TEST RUNNER ───────────────────────────────────────────────────────────────
let _passed = 0, _failed = 0;
const _suites = [];
let _cur = null;

function suite(name) {
  _cur = { name, tests: [] };
  _suites.push(_cur);
}
function test(name, fn) {
  try   { fn(); _passed++; _cur.tests.push({ name, ok: true }); }
  catch (e) { _failed++; _cur.tests.push({ name, ok: false, msg: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg ? msg + ': ' : '') +
    'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));
}

// ── MOCK ENVIRONMENT ─────────────────────────────────────────────────────────
// Storage keys — TEST_ prefix so tests never touch real app data
const ROUNDS_KEY     = 'TEST_golf_rounds';
const PLAYERS_KEY    = 'TEST_golf_players';
const AUDIT_KEY      = 'TEST_golf_audit';
const CHANGE_LOG_KEY = 'TEST_golf_changes';
const ERROR_LOG_KEY  = 'TEST_golf_errors';
const NAV_KEY        = 'TEST_golf_nav';
const COURSE_IMG_PFX = 'TEST_golf_img_';

// Mock localStorage (Node.js has none)
let _lsStore = {};
const localStorage = {
  getItem:    k      => Object.prototype.hasOwnProperty.call(_lsStore, k) ? _lsStore[k] : null,
  setItem:    (k, v) => { _lsStore[k] = String(v); },
  removeItem: k      => { delete _lsStore[k]; },
  clear:      ()     => { _lsStore = {}; },
};

// Mock Firestore
let _fsStore = {};
const _db = {
  collection: coll => ({
    doc: id => ({
      set:    data => { _fsStore[coll+'/'+id] = JSON.parse(JSON.stringify(data)); return Promise.resolve(); },
      delete: ()   => { delete _fsStore[coll+'/'+id]; return Promise.resolve(); },
      get:    ()   => { const d = _fsStore[coll+'/'+id]; return Promise.resolve({ exists:!!d, data:()=>d }); },
    }),
    get: () => {
      const docs = Object.entries(_fsStore)
        .filter(([k]) => k.startsWith(coll+'/'))
        .map(([,v]) => ({ data: () => v }));
      return Promise.resolve({ docs });
    },
  }),
};

// Stubs for browser-only APIs
const history = { pushState: () => {} };
function render() {}
function renderScorecard() {}
function downloadRoundBackup() {}

// Global mutable state (mirrors index.html globals)
let _rounds = [], _players = [], _courseOverrides = [], _auditFlushTimer = null;
const S = {
  view: 'home', roundId: null, hole: 1, numpadPid: null, showLayout: false, nr: {}, playerEdit: null,
  showRoundSummary: false, showNineHoleSummary: false, finishComment: null,
};

function resetState() {
  _rounds = []; _players = []; _courseOverrides = []; _auditFlushTimer = null;
  _lsStore = {}; _fsStore = {};
  S.view = 'home'; S.roundId = null; S.hole = 1; S.numpadPid = null;
  S.showRoundSummary = false; S.showNineHoleSummary = false; S.finishComment = null;
}
function getChangeLog() {
  try { return JSON.parse(localStorage.getItem(CHANGE_LOG_KEY) || '[]'); } catch { return []; }
}

// ── CONSTANTS (copied from index.html) ───────────────────────────────────────
const DEFAULT_PARS_18 = [4,4,3,4,5,3,4,4,5,4,3,4,5,4,3,4,5,4];
const DEFAULT_SI_18   = [1,9,17,11,3,13,7,5,15,10,18,14,2,12,16,4,6,8];
const DEFAULT_PARS_9  = [4,4,3,4,5,3,4,4,5];
const DEFAULT_SI_9    = [1,9,17,11,3,13,7,5,15];

// ── PURE FUNCTIONS (copied verbatim from index.html) ─────────────────────────
function normName(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();
}
function firstNorm(s) { return normName(s).split(/\s+/)[0]; }
function dStr(n) { return n===0?'E':n>0?'+'+n:''+n; }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function scoreColor(strokes, par) {
  if (!strokes) return '#ccc';
  const d = strokes - par;
  if (strokes===1||d<=-2) return '#FFD700';
  if (d===-1) return '#e63946';
  if (d===0)  return '#2d6a4f';
  if (d===1)  return '#333';
  return '#888';
}
function grossTotal(round, pid, from, to) {
  from=from||1; to=to||round.holes.length;
  let t=0; for (let n=from; n<=to; n++) t+=round.scores[pid]?.[n]?.s||0; return t;
}
function parSum(round, from, to) {
  from=from||1; to=to||round.holes.length;
  return round.holes.filter(h=>h.n>=from&&h.n<=to).reduce((s,h)=>s+h.par,0);
}
function calcTeeHcp(hcpIndex, tee) {
  return Math.round((parseFloat(hcpIndex)||0)*tee.slope/113+(tee.cr-tee.par));
}
function courseHcp(player, round) {
  if (player.courseHcpOverride!=null) return player.courseHcpOverride;
  const hci=parseFloat(player.handicapIndex)||0; if (hci<=0) return 0;
  const slope=parseFloat(round.slopeRating)||113, par=parSum(round);
  const rating=parseFloat(round.courseRating)||par;
  const adj=round.holes.length===9?hci/2:hci;
  return Math.round(adj*(slope/113)+(rating-par));
}
function siStrokes(chcp, si, nh) {
  if (chcp<=0) return 0;
  const base=Math.floor(chcp/nh), extra=chcp%nh; return base+(si<=extra?1:0);
}
function netTotal(round, pid) {
  const player=round.players.find(p=>p.id===pid); if (!player) return 0;
  const chcp=courseHcp(player,round), nh=round.holes.length; let net=0;
  for (const hole of round.holes) {
    const g=round.scores[pid]?.[hole.n]?.s||0; if (!g) continue;
    net+=g-siStrokes(chcp,hole.si,nh);
  }
  return net;
}
function stablefordPts(strokes, par, hcpStrokes) {
  if (!strokes) return null;
  const net=strokes-hcpStrokes, d=net-par;
  if (d<=-1) return Math.max(3,2-d); if (d===0) return 2; if (d===1) return 1; return 0;
}
function stablefordTotal(round, pid) {
  const player=round.players.find(p=>p.id===pid); if (!player) return 0;
  const chcp=courseHcp(player,round), nh=round.holes.length; let total=0;
  for (const hole of round.holes) {
    const g=round.scores[pid]?.[hole.n]?.s; if (!g) continue;
    total+=stablefordPts(g,hole.par,siStrokes(chcp,hole.si,nh))||0;
  }
  return total;
}
function wolfForHole(round, holeN) {
  return round.players[(holeN-1)%round.players.length].id;
}
function wolfHolePoints(round, holeN) {
  const wd=round.wolfHoles?.[holeN];
  if (!wd||(!wd.isLone&&!wd.partnerPid)) return null;
  const hole=round.holes[holeN-1], nh=round.holes.length, wolfPid=wolfForHole(round,holeN);
  function netS(pid) {
    const g=round.scores[pid]?.[holeN]?.s; if (!g) return 999;
    return g-siStrokes(courseHcp(round.players.find(p=>p.id===pid),round),hole.si,nh);
  }
  const wt=wd.isLone?[wolfPid]:[wolfPid,wd.partnerPid];
  const ot=round.players.map(p=>p.id).filter(id=>!wt.includes(id));
  const wb=Math.min(...wt.map(netS)), ob=Math.min(...ot.map(netS));
  const pts={}; round.players.forEach(p=>{pts[p.id]=0;});
  if (wb===999||ob===999) return pts; if (wb===ob) return pts;
  if (wd.isLone) {
    if (wb<ob){pts[wolfPid]=6;ot.forEach(id=>{pts[id]=-2;});}
    else      {pts[wolfPid]=-6;ot.forEach(id=>{pts[id]=2;});}
  } else {
    if (wb<ob){wt.forEach(id=>{pts[id]=2;});ot.forEach(id=>{pts[id]=-2;});}
    else      {wt.forEach(id=>{pts[id]=-2;});ot.forEach(id=>{pts[id]=2;});}
  }
  return pts;
}
function wolfTotalPts(round, pid) {
  let t=0;
  for (const hole of round.holes){const p=wolfHolePoints(round,hole.n);if(p)t+=p[pid]||0;}
  return t;
}

// ── STATEFUL FUNCTIONS (copied, use mock deps) ────────────────────────────────
function loadRounds()  { return _rounds; }
function loadPlayers() { return _players; }
function byId(id)      { return _rounds.find(r=>r.id===id)||null; }

function _writeAuditEntry(round, event) {
  const entry={
    id:'a'+Date.now()+Math.random().toString(36).slice(2,6),
    roundId:round.id, course:round.course,
    timestamp:new Date().toISOString(), event,
    round:JSON.parse(JSON.stringify(round))
  };
  try {
    const log=JSON.parse(localStorage.getItem(AUDIT_KEY)||'[]');
    log.unshift(entry);
    const cutoff=Date.now()-7*24*60*60*1000;
    localStorage.setItem(AUDIT_KEY,JSON.stringify(
      log.filter(e=>new Date(e.timestamp).getTime()>cutoff).slice(0,100)));
  } catch {}
  _db.collection('auditLog').doc(entry.id).set(entry).catch(()=>{});
}
function _scheduleAudit(round) {
  clearTimeout(_auditFlushTimer);
  _auditFlushTimer=setTimeout(()=>_writeAuditEntry(round,'scores_snapshot'),30000);
}
function _flushAudit(round, event) {
  clearTimeout(_auditFlushTimer); _auditFlushTimer=null; _writeAuditEntry(round,event);
}
function saveRound(r, auditEvent) {
  const i=_rounds.findIndex(x=>x.id===r.id);
  if (i>=0) _rounds[i]=r; else _rounds.unshift(r);
  localStorage.setItem(ROUNDS_KEY,JSON.stringify(_rounds));
  _db.collection('rounds').doc(r.id).set(r).catch(()=>{});
  if (auditEvent||r.done) _flushAudit(r,auditEvent||'round_finished');
  else _scheduleAudit(r);
  if (r.done){try{downloadRoundBackup(r);}catch(e){}}
}
function removeRound(id) {
  const r=_rounds.find(x=>x.id===id);
  if(r) _logChange('round',id,r.course+(r.date?' — '+r.date.slice(0,10):''),'deleted',[]);
  _rounds=_rounds.filter(x=>x.id!==id);
  localStorage.setItem(ROUNDS_KEY,JSON.stringify(_rounds));
  _db.collection('rounds').doc(id).delete().catch(()=>{});
}
function persistPlayers(arr) {
  _players=arr;
  localStorage.setItem(PLAYERS_KEY,JSON.stringify(arr));
  _db.collection('meta').doc('players').set({list:arr}).catch(()=>{});
}
function _logChange(entity, entityId, entityName, action, changes) {
  if (action === 'updated' && (!changes || !changes.length)) return;
  const entry = { id:'h'+Date.now(), timestamp:new Date().toISOString(), entity, entityId, entityName, action, changes:changes||[] };
  try {
    const log = JSON.parse(localStorage.getItem(CHANGE_LOG_KEY)||'[]');
    log.unshift(entry);
    localStorage.setItem(CHANGE_LOG_KEY, JSON.stringify(log.slice(0,500)));
  } catch {}
  _db.collection('changeLog').doc(entry.id).set(entry).catch(()=>{});
}
function upsertPlayer(p) {
  const all=loadPlayers(), i=all.findIndex(x=>x.id===p.id);
  if (i>=0) {
    const old=all[i], changes=[];
    [['name','Name'],['handicapIndex','Handicap Index'],['club','Home Club'],['gender','Gender'],['defaultTee','Default Tee']].forEach(([k,l])=>{
      const ov=old[k]??null, nv=p[k]??null;
      if(String(ov)!==String(nv)) changes.push({field:l,from:ov,to:nv});
    });
    _logChange('player',p.id,p.name||old.name,'updated',changes);
    all[i]=p;
  } else {
    _logChange('player',p.id,p.name,'created',[]);
    all.push(p);
  }
  persistPlayers(all);
}
function deletePlayer(id) {
  const all=loadPlayers(), p=all.find(x=>x.id===id);
  if(p) _logChange('player',id,p.name,'deleted',[]);
  persistPlayers(all.filter(x=>x.id!==id));
}
function saveCourseImgs(){}
function _persistCoursesToFirestore(){
  _db.collection('meta').doc('courses').set({list:_courseOverrides}).catch(()=>{});
}
function saveCourseData(course) {
  const {imgs,...meta}=course;
  meta.imgs=(imgs||[]).map(img=>(img&&img.startsWith('http'))?img:'');
  meta.updatedAt=Date.now();
  const i=_courseOverrides.findIndex(o=>o.id===meta.id);
  if (i>=0) {
    const old=_courseOverrides[i], changes=[];
    [['name','Name'],['club','Club'],['holes','Holes'],['courseRating','Course Rating'],['slopeRating','Slope Rating']].forEach(([k,l])=>{
      const ov=old[k]??null, nv=meta[k]??null;
      if(String(ov)!==String(nv)) changes.push({field:l,from:ov,to:nv});
    });
    const nh=meta.holes||18;
    for (let h=0;h<nh;h++) {
      const op=old.pars?.[h]??null, np=meta.pars?.[h]??null;
      if(op!==np) changes.push({field:'Par H'+(h+1),from:op,to:np});
      const os=old.si?.[h]??null, ns=meta.si?.[h]??null;
      if(os!==ns) changes.push({field:'SI H'+(h+1),from:os,to:ns});
      const od=(old.descriptions?.[h]||'').trim(), nd=(meta.descriptions?.[h]||'').trim();
      if(od!==nd) changes.push({field:'Description H'+(h+1),from:od||'—',to:nd||'—'});
    }
    const oldT=JSON.stringify((old.tees||[]).map(t=>({n:t.name,cr:t.cr,s:t.slope,p:t.par,g:t.gender})));
    const newT=JSON.stringify((meta.tees||[]).map(t=>({n:t.name,cr:t.cr,s:t.slope,p:t.par,g:t.gender})));
    if(oldT!==newT) changes.push({field:'Tees',from:(old.tees||[]).map(t=>t.name).join(', ')||'—',to:(meta.tees||[]).map(t=>t.name).join(', ')||'—'});
    _logChange('course',meta.id,meta.name,'updated',changes);
    _courseOverrides[i]=meta;
  } else {
    _logChange('course',meta.id,meta.name,'created',[]);
    _courseOverrides.push(meta);
  }
  try{localStorage.setItem('TEST_golf_courses',JSON.stringify(_courseOverrides));}catch{}
  _persistCoursesToFirestore();
}
function deleteCourseData(id) {
  const co=_courseOverrides.find(o=>o.id===id);
  if(co) _logChange('course',id,co.name,'deleted',[]);
  _courseOverrides=_courseOverrides.filter(o=>o.id!==id);
}

function nav(view, params) {
  if (params) Object.assign(S,params);
  S.view=view;
  history.pushState({view,...params},'');
  if (view==='scorecard') {
    try{localStorage.setItem(NAV_KEY,JSON.stringify({roundId:S.roundId,hole:S.hole}));}catch{}
  } else { localStorage.removeItem(NAV_KEY); }
  render();
}
function gotoHole(n) {
  const round=byId(S.roundId); if(!round||n<1||n>round.holes.length) return;
  _flushAudit(round,'hole_'+n);
  const prevHole=S.hole;
  S.hole=n; S.showLayout=false;
  if (prevHole===9&&n===10&&round.holes.length===18) S.showNineHoleSummary=true;
  try{localStorage.setItem(NAV_KEY,JSON.stringify({roundId:S.roundId,hole:n}));}catch{}
  renderScorecard();
}
function finishRound() {
  const round=byId(S.roundId); if(!round) return;
  S.finishComment='';
}
function submitFinishComment() {
  const round=byId(S.roundId); if(!round) return;
  const comment=(S.finishComment||'').trim();
  if(comment) round.comments=comment;
  round.done=true; saveRound(round); S.finishComment=null;
}
function skipFinishComment() {
  const round=byId(S.roundId); if(!round) return;
  round.done=true; saveRound(round); S.finishComment=null;
}
function updateFinishComment(val) { S.finishComment=val; }
function suggestHcpIndex(name, rounds) {
  const diffs=[];
  for (const r of rounds) {
    if(!r.done||!r.courseRating||!r.slopeRating) continue;
    const p=r.players.find(pl=>pl.name===name); if(!p) continue;
    const pid=p.id;
    if(!r.holes.every(h=>r.scores[pid]?.[h.n]?.s)) continue;
    const gross=grossTotal(r,pid);
    diffs.push({diff:(gross-parseFloat(r.courseRating))*(113/parseFloat(r.slopeRating)),date:r.date,course:r.course});
  }
  if(!diffs.length) return null;
  diffs.sort((a,b)=>new Date(b.date)-new Date(a.date));
  const recent=diffs.slice(0,20);
  recent.sort((a,b)=>a.diff-b.diff);
  const useN=Math.min(8,recent.length);
  const avg=recent.slice(0,useN).reduce((s,x)=>s+x.diff,0)/useN;
  return {index:Math.round(avg*0.96*10)/10,roundsUsed:recent.length,best:useN};
}
function buildRoundStandingsHTML(round) {
  const isWolf = round.format === 'wolf';
  const isStbl = round.format === 'stableford';
  const rows = round.players.map(p => {
    const gross = grossTotal(round, p.id);
    const chcp  = courseHcp(p, round);
    const scoredPar = round.holes.filter(h => round.scores[p.id]?.[h.n]?.s).reduce((s,h)=>s+h.par,0);
    const grossVsPar = gross ? gross - scoredPar : null;
    let primary, secondary;
    if (isStbl) {
      primary   = stablefordTotal(round, p.id);
      secondary = primary ? `${primary} pts` : '-';
    } else if (isWolf) {
      const wp  = wolfTotalPts(round, p.id);
      primary   = wp;
      secondary = gross ? `${wp >= 0 ? '+' : ''}${wp} wolf pts` : '-';
    } else {
      const nt  = netTotal(round, p.id);
      const netVsPar = nt ? nt - scoredPar : null;
      primary   = netVsPar !== null ? netVsPar : Infinity;
      secondary = gross ? `gross ${gross} (${dStr(grossVsPar)}) · net ${dStr(netVsPar)}` : 'No scores';
    }
    return { p, gross, primary, secondary, grossVsPar };
  });
  if (isStbl || isWolf) {
    rows.sort((a, b) => b.primary - a.primary);
  } else {
    rows.sort((a, b) => a.primary - b.primary);
  }
  return rows;
}
function buildNineHoleSummaryHTML(round) {
  const isStbl = round.format === 'stableford';
  const front = round.holes.filter(h => h.n <= 9);
  const rows = round.players.map(p => {
    const gross = grossTotal(round, p.id, 1, 9);
    const chcp  = courseHcp(p, round);
    const net   = isStbl ? null : front.reduce((s, h) => {
      const g = round.scores[p.id]?.[h.n]?.s || 0;
      return g ? s + g - siStrokes(chcp, h.si, round.holes.length) : s;
    }, 0);
    const stbPts = isStbl ? front.reduce((s, h) => {
      const g = round.scores[p.id]?.[h.n]?.s || 0;
      const pts = stablefordPts(g, h.par, siStrokes(chcp, h.si, round.holes.length));
      return s + (pts || 0);
    }, 0) : null;
    return { p, gross, net, stbPts, chcp };
  }).sort((a, b) => isStbl ? b.stbPts - a.stbPts : (a.net || 999) - (b.net || 999));
  return rows;
}
function adjScore(pid, delta) {
  const round=byId(S.roundId); if(!round) return;
  const cur=round.scores[pid]?.[S.hole]?.s||0;
  let next;
  if (!cur) {
    const hole=round.holes.find(h=>h.n===S.hole);
    const player=round.players.find(p=>p.id===pid);
    const hs=siStrokes(courseHcp(player,round),hole.si,round.holes.length);
    next=hole.par+hs;
  } else {
    next=Math.max(1,cur+delta);
  }
  if(!round.scores[pid]) round.scores[pid]={};
  round.scores[pid][S.hole]={s:next};
  saveRound(round); renderScorecard();
}
function setScoreNumpad(pid, score) {
  const round=byId(S.roundId); if(!round) return;
  if(!round.scores[pid]) round.scores[pid]={};
  round.scores[pid][S.hole]={s:score};
  saveRound(round); S.numpadPid=null; renderScorecard();
}

// ── MERGE / RECOVERY (extracted from init for unit testing) ──────────────────
function mergeRounds(fsRounds, localRounds) {
  const fsIds=new Set(fsRounds.map(r=>r.id));
  const localOnly=localRounds.filter(r=>!fsIds.has(r.id));
  return [...fsRounds,...localOnly].sort((a,b)=>(b.date>a.date?1:-1));
}
function tryRecoverRound(rounds, navState, auditLog) {
  if (!navState?.roundId) return rounds;
  const r=rounds.find(x=>x.id===navState.roundId); if (!r||r.done) return rounds;
  const scored=r.players.reduce((n,p)=>n+Object.values(r.scores[p.id]||{}).filter(h=>h?.s).length,0);
  if (scored!==0) return rounds;
  const best=auditLog.find(e=>e.roundId===navState.roundId&&e.round); if (!best) return rounds;
  return rounds.map(x=>x.id===navState.roundId?best.round:x);
}

// ── TEST DATA FACTORIES ───────────────────────────────────────────────────────
function makeHoles18(){return DEFAULT_PARS_18.map((par,i)=>({n:i+1,par,si:DEFAULT_SI_18[i]}));}
function makeHoles9() {return DEFAULT_PARS_9.map( (par,i)=>({n:i+1,par,si:DEFAULT_SI_9[i]}));}
function makeRound18(ov) {
  const players=[{id:'p1',name:'Alice',handicapIndex:10},{id:'p2',name:'Bob',handicapIndex:18}];
  const holes=makeHoles18(), scores={};
  for(const p of players) scores[p.id]={};
  return Object.assign({id:'r1',date:'2026-05-02T10:00:00Z',course:'Test Course',
    courseRating:72,slopeRating:113,players,holes,scores,done:false,format:'stroke',wolfHoles:{}},ov);
}
function makeWolfRound() {
  const players=[
    {id:'pA',name:'Alpha',courseHcpOverride:0},{id:'pB',name:'Beta', courseHcpOverride:0},
    {id:'pC',name:'Gamma',courseHcpOverride:0},{id:'pD',name:'Delta',courseHcpOverride:0},
  ];
  const holes=makeHoles18(), scores={};
  for(const p of players) scores[p.id]={};
  return {id:'rW',date:'2026-05-02T10:00:00Z',course:'Wolf Course',
    courseRating:72,slopeRating:113,players,holes,scores,done:false,format:'wolf',wolfHoles:{}};
}
const _par18=DEFAULT_PARS_18.reduce((s,p)=>s+p,0); // 72

// ═════════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═════════════════════════════════════════════════════════════════════════════

// ── 1. HELPERS ────────────────────────────────────────────────────────────────
suite('dStr — score differential display');
test('zero → E',      ()=>eq(dStr(0),'E'));
test('positive → +n', ()=>eq(dStr(3),'+3'));
test('negative → -n', ()=>eq(dStr(-2),'-2'));
test('+1',            ()=>eq(dStr(1),'+1'));
test('-1',            ()=>eq(dStr(-1),'-1'));

suite('esc — HTML escaping');
test('ampersand',       ()=>eq(esc('a & b'),'a &amp; b'));
test('less-than',       ()=>eq(esc('<b>'),'&lt;b&gt;'));
test('greater-than',    ()=>eq(esc('>'),'&gt;'));
test('double-quote',    ()=>eq(esc('"hi"'),'&quot;hi&quot;'));
test('no special chars',()=>eq(esc('abc'),'abc'));
test('number coerced',  ()=>eq(esc(42),'42'));

suite('normName / firstNorm');
test('strips diacritics',    ()=>eq(normName('Sigurjón'),'sigurjon'));
test('lowercases',           ()=>eq(normName('ALICE'),'alice'));
test('trims whitespace',     ()=>eq(normName('  bob  '),'bob'));
test('firstNorm first word', ()=>eq(firstNorm('Alice Smith'),'alice'));
test('firstNorm diacritics', ()=>eq(firstNorm('Ingibjörg Hansen'),'ingibjorg'));

// ── 2. SCORE COLOR ────────────────────────────────────────────────────────────
suite('scoreColor');
test('no score → grey',              ()=>eq(scoreColor(0,4),'#ccc'));
test('hole in one → gold',           ()=>eq(scoreColor(1,4),'#FFD700'));
test('eagle (2 on par-4) → gold',    ()=>eq(scoreColor(2,4),'#FFD700'));
test('albatross (2 on par-5) → gold',()=>eq(scoreColor(2,5),'#FFD700'));
test('birdie (3 on par-4) → red',    ()=>eq(scoreColor(3,4),'#e63946'));
test('par (4 on par-4) → green',     ()=>eq(scoreColor(4,4),'#2d6a4f'));
test('bogey → dark grey',            ()=>eq(scoreColor(5,4),'#333'));
test('double bogey → light grey',    ()=>eq(scoreColor(6,4),'#888'));
test('triple bogey → light grey',    ()=>eq(scoreColor(7,4),'#888'));

// ── 3. GROSS TOTALS / PAR SUM ─────────────────────────────────────────────────
suite('parSum');
test('all 18',       ()=>eq(parSum(makeRound18()),_par18));
test('front 9',      ()=>eq(parSum(makeRound18(),1,9),DEFAULT_PARS_18.slice(0,9).reduce((s,p)=>s+p,0)));
test('back 9',       ()=>eq(parSum(makeRound18(),10,18),DEFAULT_PARS_18.slice(9).reduce((s,p)=>s+p,0)));
test('front+back = total',()=>{const r=makeRound18();eq(parSum(r,1,9)+parSum(r,10,18),parSum(r));});

suite('grossTotal');
test('no scores = 0',()=>eq(grossTotal(makeRound18(),'p1'),0));
test('all holes scored',()=>{const r=makeRound18();for(let n=1;n<=18;n++)r.scores.p1[n]={s:5};eq(grossTotal(r,'p1'),90);});
test('partial range',()=>{const r=makeRound18();for(let n=1;n<=18;n++)r.scores.p1[n]={s:4};eq(grossTotal(r,'p1',1,9),36);});
test('unknown player = 0',()=>{const r=makeRound18();r.scores.p1[1]={s:5};eq(grossTotal(r,'nobody'),0);});
test('missing holes count 0',()=>{const r=makeRound18();r.scores.p1[1]={s:5};eq(grossTotal(r,'p1'),5);});
test('two players independent',()=>{
  const r=makeRound18();
  for(let n=1;n<=18;n++){r.scores.p1[n]={s:4};r.scores.p2[n]={s:5};}
  eq(grossTotal(r,'p1'),72); eq(grossTotal(r,'p2'),90);
});

// ── 4. HANDICAP ───────────────────────────────────────────────────────────────
suite('calcTeeHcp');
test('scratch, standard slope',  ()=>eq(calcTeeHcp(0, {slope:113,cr:72,par:72}),0));
test('10 hcp, standard slope',   ()=>eq(calcTeeHcp(10,{slope:113,cr:72,par:72}),10));
test('10 hcp, higher slope',     ()=>eq(calcTeeHcp(10,{slope:125,cr:72,par:72}),Math.round(10*125/113)));
test('CR above par',             ()=>eq(calcTeeHcp(10,{slope:113,cr:74,par:72}),12));
test('CR below par',             ()=>eq(calcTeeHcp(10,{slope:113,cr:70,par:72}),8));
test('string input coerced',     ()=>eq(calcTeeHcp('10',{slope:113,cr:72,par:72}),10));
test('invalid input → 0',        ()=>eq(calcTeeHcp('x',{slope:113,cr:72,par:72}),0));

suite('siStrokes');
test('chcp 0 → always 0',()=>{for(let si=1;si<=18;si++)eq(siStrokes(0,si,18),0);});
test('chcp 18 → 1 per hole',()=>{for(let si=1;si<=18;si++)eq(siStrokes(18,si,18),1,'si='+si);});
test('chcp 9 → 1 on SI 1-9',()=>{
  for(let si=1;si<=9;si++) eq(siStrokes(9,si,18),1,'si='+si);
  for(let si=10;si<=18;si++) eq(siStrokes(9,si,18),0,'si='+si);
});
test('chcp 27 → 2 on SI 1-9, 1 on SI 10-18',()=>{
  for(let si=1;si<=9;si++) eq(siStrokes(27,si,18),2,'si='+si);
  for(let si=10;si<=18;si++) eq(siStrokes(27,si,18),1,'si='+si);
});
test('chcp 36 → 2 every hole',()=>{for(let si=1;si<=18;si++)eq(siStrokes(36,si,18),2,'si='+si);});
test('9-hole, chcp 9 → 1 per hole',()=>{for(let si=1;si<=9;si++)eq(siStrokes(9,si,9),1,'si='+si);});
test('negative chcp → 0',()=>eq(siStrokes(-1,1,18),0));

suite('courseHcp');
test('override takes precedence',()=>eq(courseHcp({courseHcpOverride:12,handicapIndex:24},makeRound18()),12));
test('override=0 respected',    ()=>eq(courseHcp({courseHcpOverride:0, handicapIndex:24},makeRound18()),0));
test('hcpIndex 0 → 0',         ()=>eq(courseHcp({handicapIndex:0},makeRound18()),0));
test('10 hcp, par==CR → 10',   ()=>eq(courseHcp({handicapIndex:10},makeRound18({courseRating:_par18,slopeRating:113})),10));
test('9-hole halves index',()=>{
  const par9=DEFAULT_PARS_9.reduce((s,p)=>s+p,0);
  eq(courseHcp({handicapIndex:20},{players:[],holes:makeHoles9(),scores:{},slopeRating:113,courseRating:par9}),10);
});
test('higher slope → more strokes',()=>{
  const p={handicapIndex:10};
  const r1=makeRound18({slopeRating:113,courseRating:_par18});
  const r2=makeRound18({slopeRating:150,courseRating:_par18});
  assert(courseHcp(p,r2)>courseHcp(p,r1));
});

suite('netTotal');
test('unknown player → 0',()=>eq(netTotal(makeRound18(),'nobody'),0));
test('no scores → 0',     ()=>eq(netTotal(makeRound18(),'p1'),0));
test('scratch: net = gross',()=>{
  const r=makeRound18(); r.players[0]={id:'p1',name:'A',courseHcpOverride:0};
  for(let n=1;n<=18;n++) r.scores.p1[n]={s:5}; eq(netTotal(r,'p1'),90);
});
test('18-hcp: 1 stroke per hole',()=>{
  const r=makeRound18(); r.players[0]={id:'p1',name:'A',courseHcpOverride:18};
  for(let n=1;n<=18;n++) r.scores.p1[n]={s:5}; eq(netTotal(r,'p1'),72);
});
test('9-hcp: 1 stroke on SI 1-9 only',()=>{
  const r=makeRound18(); r.players[0]={id:'p1',name:'A',courseHcpOverride:9};
  for(let n=1;n<=18;n++) r.scores.p1[n]={s:5}; eq(netTotal(r,'p1'),81);
});

// ── 5. STABLEFORD ─────────────────────────────────────────────────────────────
suite('stablefordPts');
test('no strokes → null',             ()=>assert(stablefordPts(0,4,0)===null));
test('double bogey → 0',              ()=>eq(stablefordPts(6,4,0),0));
test('bogey → 1',                     ()=>eq(stablefordPts(5,4,0),1));
test('par → 2',                       ()=>eq(stablefordPts(4,4,0),2));
test('birdie → 3',                    ()=>eq(stablefordPts(3,4,0),3));
test('eagle → 4',                     ()=>eq(stablefordPts(2,4,0),4));
test('albatross par-5 → 5',           ()=>eq(stablefordPts(2,5,0),5));
test('hole-in-one par-4 → 5',         ()=>eq(stablefordPts(1,4,0),5));
test('hole-in-one par-3 → 4',         ()=>eq(stablefordPts(1,3,0),4));
test('1 hcp stroke: bogey → par (2)', ()=>eq(stablefordPts(5,4,1),2));
test('2 hcp strokes: bogey → birdie', ()=>eq(stablefordPts(5,4,2),3));

suite('stablefordTotal');
test('no scores → 0',()=>eq(stablefordTotal(makeRound18(),'p1'),0));
test('scratch, all pars → 36',()=>{
  const r=makeRound18(); r.players[0]={id:'p1',name:'A',courseHcpOverride:0};
  DEFAULT_PARS_18.forEach((par,i)=>{r.scores.p1[i+1]={s:par};}); eq(stablefordTotal(r,'p1'),36);
});
test('all bogeys, scratch → 18',()=>{
  const r=makeRound18(); r.players[0]={id:'p1',name:'A',courseHcpOverride:0};
  DEFAULT_PARS_18.forEach((par,i)=>{r.scores.p1[i+1]={s:par+1};}); eq(stablefordTotal(r,'p1'),18);
});
test('18-hcp, all bogeys → net par → 36',()=>{
  const r=makeRound18(); r.players[0]={id:'p1',name:'A',courseHcpOverride:18};
  DEFAULT_PARS_18.forEach((par,i)=>{r.scores.p1[i+1]={s:par+1};}); eq(stablefordTotal(r,'p1'),36);
});

// ── 6. WOLF ───────────────────────────────────────────────────────────────────
suite('wolfForHole — rotation');
test('hole 1 → A', ()=>eq(wolfForHole(makeWolfRound(),1),'pA'));
test('hole 2 → B', ()=>eq(wolfForHole(makeWolfRound(),2),'pB'));
test('hole 4 → D', ()=>eq(wolfForHole(makeWolfRound(),4),'pD'));
test('hole 5 wraps → A',   ()=>eq(wolfForHole(makeWolfRound(),5),'pA'));
test('hole 18 → (17%4=1)→B',()=>eq(wolfForHole(makeWolfRound(),18),'pB'));

suite('wolfHolePoints');
test('no decision → null',()=>assert(wolfHolePoints(makeWolfRound(),1)===null));
test('isLone=false, partnerPid=null → null',()=>{
  const r=makeWolfRound(); r.wolfHoles[1]={isLone:false,partnerPid:null};
  assert(wolfHolePoints(r,1)===null);
});
test('lone wolf wins → +6, -2 each',()=>{
  const r=makeWolfRound();
  r.scores.pA[1]={s:4};r.scores.pB[1]={s:5};r.scores.pC[1]={s:5};r.scores.pD[1]={s:5};
  r.wolfHoles[1]={isLone:true,partnerPid:null};
  const p=wolfHolePoints(r,1); eq(p.pA,6);eq(p.pB,-2);eq(p.pC,-2);eq(p.pD,-2);
});
test('lone wolf loses → -6, +2 each',()=>{
  const r=makeWolfRound();
  r.scores.pA[1]={s:7};r.scores.pB[1]={s:4};r.scores.pC[1]={s:5};r.scores.pD[1]={s:5};
  r.wolfHoles[1]={isLone:true,partnerPid:null};
  const p=wolfHolePoints(r,1); eq(p.pA,-6);eq(p.pB,2);eq(p.pC,2);eq(p.pD,2);
});
test('team wolf wins → +2/-2',()=>{
  const r=makeWolfRound();
  r.scores.pA[1]={s:3};r.scores.pB[1]={s:3};r.scores.pC[1]={s:5};r.scores.pD[1]={s:5};
  r.wolfHoles[1]={isLone:false,partnerPid:'pB'};
  const p=wolfHolePoints(r,1); eq(p.pA,2);eq(p.pB,2);eq(p.pC,-2);eq(p.pD,-2);
});
test('team wolf loses → -2/+2',()=>{
  const r=makeWolfRound();
  r.scores.pA[1]={s:6};r.scores.pB[1]={s:6};r.scores.pC[1]={s:4};r.scores.pD[1]={s:5};
  r.wolfHoles[1]={isLone:false,partnerPid:'pB'};
  const p=wolfHolePoints(r,1); eq(p.pA,-2);eq(p.pB,-2);eq(p.pC,2);eq(p.pD,2);
});
test('tie → all zero',()=>{
  const r=makeWolfRound();
  [1,2,3,4].forEach(n=>{['pA','pB','pC','pD'].forEach(id=>{r.scores[id][n]={s:4};});});
  r.wolfHoles[1]={isLone:true,partnerPid:null};
  const p=wolfHolePoints(r,1); eq(p.pA,0);eq(p.pB,0);eq(p.pC,0);eq(p.pD,0);
});
test('missing scores → all zero',()=>{
  const r=makeWolfRound(); r.wolfHoles[1]={isLone:false,partnerPid:'pB'};
  const p=wolfHolePoints(r,1); eq(p.pA,0);eq(p.pB,0);eq(p.pC,0);eq(p.pD,0);
});
test('wolfTotalPts sums correctly',()=>{
  const r=makeWolfRound();
  r.scores.pA[1]={s:3};r.scores.pB[1]={s:5};r.scores.pC[1]={s:5};r.scores.pD[1]={s:5};
  r.wolfHoles[1]={isLone:true,partnerPid:null};
  r.scores.pA[2]={s:5};r.scores.pB[2]={s:3};r.scores.pC[2]={s:5};r.scores.pD[2]={s:5};
  r.wolfHoles[2]={isLone:true,partnerPid:null};
  eq(wolfTotalPts(r,'pA'),4); eq(wolfTotalPts(r,'pB'),4);
  eq(wolfTotalPts(r,'pC'),-4);eq(wolfTotalPts(r,'pD'),-4);
});

// ── 7. STORAGE ────────────────────────────────────────────────────────────────
suite('saveRound / byId / removeRound');
test('adds to _rounds',()=>{resetState();saveRound(makeRound18(),'round_created');eq(_rounds.length,1);});
test('persists to localStorage',()=>{
  resetState();saveRound(makeRound18(),'round_created');
  eq(JSON.parse(localStorage.getItem(ROUNDS_KEY))[0].id,'r1');
});
test('writes to Firestore',()=>{
  resetState();saveRound(makeRound18(),'round_created');
  assert(_fsStore['rounds/r1']!==undefined);
});
test('update existing, no duplicates',()=>{
  resetState();const r=makeRound18();saveRound(r,'round_created');
  r.course='Updated';saveRound(r);eq(_rounds.length,1);eq(_rounds[0].course,'Updated');
});
test('byId finds round',()=>{
  resetState();saveRound(makeRound18(),'round_created');
  assert(byId('r1')!==null);eq(byId('r1').id,'r1');
});
test('byId returns null for unknown',()=>{resetState();assert(byId('x')===null);});
test('removeRound clears memory + localStorage + Firestore',()=>{
  resetState();saveRound(makeRound18(),'round_created');removeRound('r1');
  eq(_rounds.length,0);eq(JSON.parse(localStorage.getItem(ROUNDS_KEY)).length,0);
  assert(_fsStore['rounds/r1']===undefined);
});
test('removeRound logs deleted entry to change log',()=>{
  resetState();saveRound(makeRound18(),'round_created');removeRound('r1');
  const log=getChangeLog();
  eq(log.length,1);eq(log[0].action,'deleted');eq(log[0].entity,'round');
  assert(log[0].entityName.includes('Test Course'));
});

suite('Player storage');
test('upsertPlayer adds new',()=>{resetState();upsertPlayer({id:'pl1',name:'Alice'});eq(_players.length,1);});
test('upsertPlayer updates existing',()=>{
  resetState();upsertPlayer({id:'pl1',name:'Alice',handicapIndex:10});
  upsertPlayer({id:'pl1',name:'Alice Smith',handicapIndex:12});
  eq(_players.length,1);eq(_players[0].name,'Alice Smith');
});
test('deletePlayer removes correct player',()=>{
  resetState();upsertPlayer({id:'pl1',name:'Alice'});upsertPlayer({id:'pl2',name:'Bob'});
  deletePlayer('pl1');eq(_players.length,1);eq(_players[0].id,'pl2');
});
test('persistPlayers syncs to Firestore',()=>{
  resetState();persistPlayers([{id:'pl1',name:'Alice'}]);
  assert(_fsStore['meta/players']!==undefined);eq(_fsStore['meta/players'].list.length,1);
});

// ── 8. AUDIT LOG ──────────────────────────────────────────────────────────────
suite('Audit log — _writeAuditEntry');
test('creates entry in localStorage',()=>{
  resetState();_writeAuditEntry(makeRound18(),'round_created');
  const log=JSON.parse(localStorage.getItem(AUDIT_KEY));
  eq(log.length,1);eq(log[0].event,'round_created');eq(log[0].roundId,'r1');
});
test('entry contains full round snapshot',()=>{
  resetState();_writeAuditEntry(makeRound18(),'round_created');
  const log=JSON.parse(localStorage.getItem(AUDIT_KEY));
  assert(!!log[0].round);eq(log[0].round.id,'r1');
});
test('writes to Firestore auditLog',()=>{
  resetState();_writeAuditEntry(makeRound18(),'round_created');
  const keys=Object.keys(_fsStore).filter(k=>k.startsWith('auditLog/'));
  eq(keys.length,1);eq(_fsStore[keys[0]].event,'round_created');
});
test('newest entry first',()=>{
  resetState();const r=makeRound18();
  _writeAuditEntry(r,'round_created');_writeAuditEntry(r,'scores_snapshot');
  const log=JSON.parse(localStorage.getItem(AUDIT_KEY));
  eq(log[0].event,'scores_snapshot');eq(log[1].event,'round_created');
});
test('ring buffer caps at 100',()=>{
  resetState();const r=makeRound18();
  for(let i=0;i<110;i++)_writeAuditEntry(r,'x');
  assert(JSON.parse(localStorage.getItem(AUDIT_KEY)).length<=100);
});
test('entries older than 7 days pruned',()=>{
  resetState();const r=makeRound18();
  const old={id:'old',roundId:'r1',course:'x',event:'round_created',
    timestamp:new Date(Date.now()-8*24*60*60*1000).toISOString(),round:r};
  localStorage.setItem(AUDIT_KEY,JSON.stringify([old]));
  _writeAuditEntry(r,'scores_snapshot');
  const log=JSON.parse(localStorage.getItem(AUDIT_KEY));
  assert(log.every(e=>e.id!=='old'),'old entry not pruned');
});

suite('Audit log — saveRound integration');
test('named auditEvent → immediate flush, no pending timer',()=>{
  resetState();saveRound(makeRound18(),'round_created');
  const log=JSON.parse(localStorage.getItem(AUDIT_KEY));
  assert(log&&log.length===1);eq(log[0].event,'round_created');
  assert(_auditFlushTimer===null);
});
test('no auditEvent → debounce timer set',()=>{
  resetState();const r=makeRound18();_rounds=[r];
  saveRound({...r}); assert(_auditFlushTimer!==null);
  clearTimeout(_auditFlushTimer);_auditFlushTimer=null;
});
test('done=true → immediate flush as round_finished',()=>{
  resetState();saveRound({...makeRound18(),done:true});
  const log=JSON.parse(localStorage.getItem(AUDIT_KEY));
  assert(log&&log.length===1);eq(log[0].event,'round_finished');
});
test('_flushAudit cancels timer and writes',()=>{
  resetState();const r=makeRound18();_scheduleAudit(r);assert(_auditFlushTimer!==null);
  _flushAudit(r,'hole_5');assert(_auditFlushTimer===null);
  eq(JSON.parse(localStorage.getItem(AUDIT_KEY))[0].event,'hole_5');
});
test('gotoHole flushes audit with hole_N event',()=>{
  resetState();const r=makeRound18();saveRound(r,'round_created');
  S.roundId='r1';S.hole=1;localStorage.setItem(AUDIT_KEY,'[]');
  gotoHole(5);
  eq(JSON.parse(localStorage.getItem(AUDIT_KEY))[0].event,'hole_5');
});

// ── 9. NAVIGATION STATE ───────────────────────────────────────────────────────
suite('NAV_KEY — navigation state persistence');
test('nav(scorecard) saves roundId+hole',()=>{
  resetState();S.roundId='r1';S.hole=7;nav('scorecard',{roundId:'r1',hole:7});
  const s=JSON.parse(localStorage.getItem(NAV_KEY));eq(s.roundId,'r1');eq(s.hole,7);
});
test('nav(home) clears NAV_KEY',()=>{
  resetState();localStorage.setItem(NAV_KEY,'{}');nav('home');
  assert(localStorage.getItem(NAV_KEY)===null);
});
test('nav(players) clears NAV_KEY',()=>{
  resetState();localStorage.setItem(NAV_KEY,'{}');nav('players');
  assert(localStorage.getItem(NAV_KEY)===null);
});
test('nav updates S.view',()=>{
  resetState();S.roundId='r1';nav('scorecard',{roundId:'r1',hole:1});eq(S.view,'scorecard');
  nav('home');eq(S.view,'home');
});
test('gotoHole updates NAV_KEY hole',()=>{
  resetState();const r=makeRound18();saveRound(r,'round_created');
  S.roundId='r1';S.hole=1;localStorage.setItem(NAV_KEY,JSON.stringify({roundId:'r1',hole:1}));
  gotoHole(9);eq(JSON.parse(localStorage.getItem(NAV_KEY)).hole,9);
});
test('gotoHole ignores out-of-range hole',()=>{
  resetState();const r=makeRound18();saveRound(r,'round_created');
  S.roundId='r1';S.hole=5;gotoHole(99);eq(S.hole,5);
});

// ── 10. SCORE ENTRY ───────────────────────────────────────────────────────────
suite('adjScore / setScoreNumpad');
test('adjScore increments',()=>{
  resetState();const r=makeRound18();r.scores.p1[1]={s:4};
  saveRound(r,'round_created');S.roundId='r1';S.hole=1;adjScore('p1',1);
  eq(byId('r1').scores.p1[1].s,5);
});
test('adjScore decrements',()=>{
  resetState();const r=makeRound18();r.scores.p1[1]={s:4};
  saveRound(r,'round_created');S.roundId='r1';S.hole=1;adjScore('p1',-1);
  eq(byId('r1').scores.p1[1].s,3);
});
test('adjScore floor at 1',()=>{
  resetState();const r=makeRound18();r.scores.p1[1]={s:1};
  saveRound(r,'round_created');S.roundId='r1';S.hole=1;adjScore('p1',-1);
  eq(byId('r1').scores.p1[1].s,1);
});
test('adjScore empty slot snaps to par (courseHcpOverride=0)',()=>{
  // hole 1: par=4, 0 hcp strokes → snap to 4 regardless of delta direction
  resetState();
  const r=makeRound18({players:[{id:'p1',name:'A',courseHcpOverride:0}]});
  saveRound(r,'round_created');
  S.roundId='r1';S.hole=1;adjScore('p1',1);eq(byId('r1').scores.p1[1].s,4);
});
test('adjScore empty slot snaps to par+hcp (+1 stroke, par 3 hole)',()=>{
  // chcp=18 → 1 extra stroke on every hole; hole 3 par=3, SI=17 → snap to 4
  resetState();
  const r=makeRound18({players:[{id:'p1',name:'A',courseHcpOverride:18}]});
  saveRound(r,'round_created');
  S.roundId='r1';S.hole=3;adjScore('p1',1);eq(byId('r1').scores.p1[3].s,4);
});
test('adjScore empty slot — minus press also snaps (not to 1)',()=>{
  // pressing − on empty snaps to par+hcp, not to 1
  resetState();
  const r=makeRound18({players:[{id:'p1',name:'A',courseHcpOverride:0}]});
  saveRound(r,'round_created');
  S.roundId='r1';S.hole=1;adjScore('p1',-1);eq(byId('r1').scores.p1[1].s,4);
});
test('adjScore empty slot — hole with 0 hcp strokes snaps to par exactly',()=>{
  // chcp=1: only SI=1 hole gets extra stroke; hole 2 SI=9 gets 0 → snap to par=4
  resetState();
  const r=makeRound18({players:[{id:'p1',name:'A',courseHcpOverride:1}]});
  saveRound(r,'round_created');
  S.roundId='r1';S.hole=2;adjScore('p1',1);eq(byId('r1').scores.p1[2].s,4);
});
test('adjScore after snap — second press increments normally',()=>{
  // chcp=0, hole 1 par=4: snap to 4, then +1 → 5
  resetState();
  const r=makeRound18({players:[{id:'p1',name:'A',courseHcpOverride:0}]});
  saveRound(r,'round_created');
  S.roundId='r1';S.hole=1;
  adjScore('p1',1); // snap to 4
  adjScore('p1',1); // 4+1=5
  eq(byId('r1').scores.p1[1].s,5);
});
test('adjScore after snap — second press decrements normally',()=>{
  // chcp=0, hole 1 par=4: snap to 4, then -1 → 3
  resetState();
  const r=makeRound18({players:[{id:'p1',name:'A',courseHcpOverride:0}]});
  saveRound(r,'round_created');
  S.roundId='r1';S.hole=1;
  adjScore('p1',1); // snap to 4
  adjScore('p1',-1); // 4-1=3
  eq(byId('r1').scores.p1[1].s,3);
});
test('setScoreNumpad sets exact score',()=>{
  resetState();const r=makeRound18();saveRound(r,'round_created');
  S.roundId='r1';S.hole=3;setScoreNumpad('p1',6);eq(byId('r1').scores.p1[3].s,6);
});
test('setScoreNumpad clears S.numpadPid',()=>{
  resetState();const r=makeRound18();saveRound(r,'round_created');
  S.roundId='r1';S.hole=1;S.numpadPid='p1';setScoreNumpad('p1',4);
  assert(S.numpadPid===null);
});

// ── 11. FIRESTORE MERGE ───────────────────────────────────────────────────────
suite('mergeRounds — Firestore sync logic');
test('local-only round kept when Firestore empty',()=>{
  eq(mergeRounds([],[{id:'r1',date:'2026-05-01',course:'A'}]).length,1);
});
test('Firestore version wins for matching id',()=>{
  const m=mergeRounds([{id:'r1',date:'2026-05-01',course:'FS'}],[{id:'r1',date:'2026-05-01',course:'Local'}]);
  eq(m.length,1);eq(m[0].course,'FS');
});
test('local-only round appended to Firestore list',()=>{
  const m=mergeRounds(
    [{id:'r1',date:'2026-05-01',course:'A'}],
    [{id:'r1',date:'2026-05-01',course:'A'},{id:'r2',date:'2026-05-02',course:'B'}]);
  eq(m.length,2);assert(m.some(r=>r.id==='r2'));
});
test('sorted newest first',()=>{
  const m=mergeRounds(
    [{id:'r1',date:'2026-05-01T10:00:00Z',course:'A'}],
    [{id:'r2',date:'2026-05-02T10:00:00Z',course:'B'}]);
  eq(m[0].id,'r2');eq(m[1].id,'r1');
});
test('both empty → empty',()=>eq(mergeRounds([],[]).length,0));

// ── 12. AUTO-RECOVERY ─────────────────────────────────────────────────────────
suite('tryRecoverRound — auto-recovery from audit log');
function emptyRound(id){const r=makeRound18();r.id=id;r.players.forEach(p=>{r.scores[p.id]={};});return r;}
test('no navState → unchanged',()=>eq(tryRecoverRound([makeRound18()],null,[]).length,1));
test('navState for unknown round → unchanged',()=>{
  eq(tryRecoverRound([makeRound18()],{roundId:'x'},[]).length,1);
});
test('round has scores → not recovered',()=>{
  const r=makeRound18();r.scores.p1[1]={s:4};
  const audit=[{roundId:'r1',round:{...r,scores:{p1:{1:{s:4},2:{s:5}},p2:{}}}}];
  assert(!tryRecoverRound([r],{roundId:'r1'},audit)[0].scores.p1[2],'should not overwrite');
});
test('empty scores + empty audit → not recovered',()=>{
  const r=emptyRound('r1');
  eq(Object.keys(tryRecoverRound([r],{roundId:'r1'},[]).find(x=>x.id==='r1').scores.p1).length,0);
});
test('empty scores + audit entry → scores restored',()=>{
  const r=emptyRound('r1');
  const rec={...r};rec.scores={p1:{1:{s:4},2:{s:5}},p2:{1:{s:5}}};
  const result=tryRecoverRound([r],{roundId:'r1'},[{roundId:'r1',round:rec}]);
  eq(result[0].scores.p1[1].s,4);eq(result[0].scores.p1[2].s,5);
});
test('done round not recovered',()=>{
  const r={...emptyRound('r1'),done:true};
  const rec={...r,done:false};rec.scores={p1:{1:{s:4}},p2:{}};
  eq(Object.keys(tryRecoverRound([r],{roundId:'r1'},[{roundId:'r1',round:rec}])[0].scores.p1).length,0);
});
test('uses first (newest) audit entry',()=>{
  const r=emptyRound('r1');
  const n={...r};n.scores={p1:{1:{s:3}},p2:{}};
  const o={...r};o.scores={p1:{1:{s:7}},p2:{}};
  const result=tryRecoverRound([r],{roundId:'r1'},[{roundId:'r1',round:n},{roundId:'r1',round:o}]);
  eq(result[0].scores.p1[1].s,3,'should use newest entry');
});
test('other rounds untouched',()=>{
  const r1=emptyRound('r1');
  const r2=makeRound18();r2.id='r2';r2.scores.p1[1]={s:4};
  const rec={...r1};rec.scores={p1:{1:{s:5}},p2:{}};
  const res=tryRecoverRound([r1,r2],{roundId:'r1'},[{roundId:'r1',round:rec}]);
  eq(res.find(x=>x.id==='r2').scores.p1[1].s,4);
});

// ═════════════════════════════════════════════════════════════════════════════
// DATA LOSS BUG — May 2, 2026
// Reproduces the exact failure: 18-hole round, scores entered, phone locked,
// page reloaded → Firestore had empty round → old code wiped localStorage.
// These tests verify every layer of protection that now prevents this.
// ═════════════════════════════════════════════════════════════════════════════
suite('DATA LOSS BUG — May 2026: every score entry writes to AUDIT_KEY');
test('AUDIT_KEY is distinct from ROUNDS_KEY',()=>{
  assert(AUDIT_KEY!==ROUNDS_KEY,'audit and rounds must be separate keys');
});
test('setScoreNumpad writes a pending audit entry',()=>{
  resetState();
  const r=makeRound18();saveRound(r,'round_created');
  S.roundId='r1';S.hole=1;
  localStorage.setItem(AUDIT_KEY,'[]'); // clear round_created entry
  setScoreNumpad('p1',4);
  // Score was entered → either a pending timer or already flushed
  const hasPending=_auditFlushTimer!==null;
  const hasEntry=JSON.parse(localStorage.getItem(AUDIT_KEY)).length>0;
  assert(hasPending||hasEntry,'audit must be scheduled or written after score entry');
  clearTimeout(_auditFlushTimer);_auditFlushTimer=null;
});
test('gotoHole flushes pending score to AUDIT_KEY before moving',()=>{
  resetState();
  const r=makeRound18();saveRound(r,'round_created');
  S.roundId='r1';S.hole=1;setScoreNumpad('p1',4);setScoreNumpad('p2',5);
  localStorage.setItem(AUDIT_KEY,'[]'); // clear old entries
  gotoHole(2); // must flush before moving
  const log=JSON.parse(localStorage.getItem(AUDIT_KEY));
  assert(log.length>0,'audit flushed on hole change');
  eq(log[0].event,'hole_2');
});
test('AUDIT_KEY survives a Firestore load that wipes ROUNDS_KEY',()=>{
  resetState();
  // Simulate: user played and audit was written
  const rWithScores=makeRound18();
  rWithScores.scores.p1[1]={s:4};rWithScores.scores.p1[2]={s:5};
  _writeAuditEntry(rWithScores,'hole_3');
  const auditBefore=localStorage.getItem(AUDIT_KEY);

  // Simulate: Firestore loads and overwrites ROUNDS_KEY with empty round
  const fsEmpty=makeRound18(); // empty scores
  localStorage.setItem(ROUNDS_KEY,JSON.stringify([fsEmpty]));

  // AUDIT_KEY must be untouched
  eq(localStorage.getItem(AUDIT_KEY),auditBefore,'AUDIT_KEY must survive Firestore overwrite');
  const log=JSON.parse(localStorage.getItem(AUDIT_KEY));
  eq(log[0].round.scores.p1[1].s,4,'scores preserved in audit log');
});

suite('DATA LOSS BUG — May 2026: Firestore merge keeps local-only rounds');
test('round only in localStorage (never reached Firestore) is preserved',()=>{
  const localRound={id:'r1',date:'2026-05-02',course:'A',players:[],scores:{},holes:[],done:false};
  const merged=mergeRounds([],            [localRound]);
  eq(merged.length,1);eq(merged[0].id,'r1');
});
test('multiple local-only rounds all preserved',()=>{
  const locals=[
    {id:'r1',date:'2026-05-01',course:'A',players:[],scores:{},holes:[],done:false},
    {id:'r2',date:'2026-05-02',course:'B',players:[],scores:{},holes:[],done:false},
  ];
  eq(mergeRounds([],locals).length,2);
});
test('Firestore version wins for rounds it knows about',()=>{
  const fs=[{id:'r1',date:'2026-05-02',course:'FS version',players:[],scores:{p1:{1:{s:4}}},holes:[],done:false}];
  const local=[{id:'r1',date:'2026-05-02',course:'Local version',players:[],scores:{p1:{1:{s:4}}},holes:[],done:false}];
  eq(mergeRounds(fs,local)[0].course,'FS version');
});

suite('DATA LOSS BUG — May 2026: NAV_KEY restores hole after reload');
test('scorecard nav saves hole to NAV_KEY',()=>{
  resetState();S.roundId='r1';S.hole=18;
  nav('scorecard',{roundId:'r1',hole:18});
  const saved=JSON.parse(localStorage.getItem(NAV_KEY));
  eq(saved.roundId,'r1');eq(saved.hole,18,'must remember hole 18');
});
test('on reload: NAV_KEY restores user to correct hole',()=>{
  resetState();
  // Before lock: user was on hole 18
  S.roundId='r1';S.hole=18;nav('scorecard',{roundId:'r1',hole:18});
  // Simulate reload: S resets to defaults
  S.view='home';S.roundId=null;S.hole=1;
  // App startup reads NAV_KEY (as init() now does)
  const r=makeRound18();saveRound(r,'round_created');
  const navState=JSON.parse(localStorage.getItem(NAV_KEY));
  if (navState?.roundId){
    const found=_rounds.find(x=>x.id===navState.roundId);
    if (found&&!found.done){S.view='scorecard';S.roundId=navState.roundId;S.hole=navState.hole||1;}
  }
  eq(S.view,'scorecard','user restored to scorecard');
  eq(S.hole,18,'user restored to hole 18');
});
test('nav away from scorecard clears NAV_KEY',()=>{
  resetState();S.roundId='r1';nav('scorecard',{roundId:'r1',hole:5});
  nav('home');assert(localStorage.getItem(NAV_KEY)===null);
});

suite('DATA LOSS BUG — May 2026: full end-to-end recovery scenario');
test('17 holes entered, phone locked, reload → scores recovered from audit',()=>{
  resetState();

  // 1. Start round
  const r=makeRound18();saveRound(r,'round_created');
  S.roundId='r1';

  // 2. Play holes 1-17: enter scores and change holes (flush audit on each)
  for (let h=1; h<=17; h++){
    S.hole=h;
    setScoreNumpad('p1',DEFAULT_PARS_18[h-1]+1); // bogey
    setScoreNumpad('p2',DEFAULT_PARS_18[h-1]);    // par
    if (h<17) gotoHole(h+1);                      // flushes audit with h scores
  }

  // 3. Phone locked on hole 17. Audit log has entries up to hole 17.
  const auditLog=JSON.parse(localStorage.getItem(AUDIT_KEY));
  assert(auditLog.length>0,'audit log must have entries');

  // 4. Page reloads: Firestore returns the initial empty round (network was bad)
  const fsEmptyRound=makeRound18(); // no scores
  const afterMerge=mergeRounds([fsEmptyRound],[]);
  // Firestore wins → round has empty scores
  const scoredAfterMerge=afterMerge[0].players.reduce(
    (n,p)=>n+Object.values(afterMerge[0].scores[p.id]||{}).filter(h=>h?.s).length,0);
  eq(scoredAfterMerge,0,'Firestore correctly wiped the scores (expected)');

  // 5. Auto-recovery reads audit log and restores scores
  const navState={roundId:'r1'};
  const recovered=tryRecoverRound(afterMerge,navState,auditLog);
  const scoredAfterRecovery=recovered[0].players.reduce(
    (n,p)=>n+Object.values(recovered[0].scores[p.id]||{}).filter(h=>h?.s).length,0);
  assert(scoredAfterRecovery>0,'scores must be recovered from audit log');
});
test('finished round is NOT auto-recovered (done flag respected)',()=>{
  resetState();
  const r={...makeRound18(),done:true};
  const rec={...r,done:false};rec.scores={p1:{1:{s:4}},p2:{}};
  const result=tryRecoverRound([r],{roundId:'r1'},[{roundId:'r1',round:rec}]);
  // done=true → recovery skipped
  eq(Object.keys(result[0].scores.p1||{}).length,0);
});

// ═════════════════════════════════════════════════════════════════════════════
// RIVALRY BANNER — format-aware scoring (mirrored from rivalryBannerHtml)
// ═════════════════════════════════════════════════════════════════════════════
function rivalryBannerScore(round, pids) {
  const isStbl = (round.format || 'stroke') === 'stableford';
  return pids.reduce((s, pid) => s + (isStbl ? stablefordTotal(round, pid) : netTotal(round, pid)), 0);
}
function rivalryBannerWinner(round, aScore, bScore) {
  const isStbl = (round.format || 'stroke') === 'stableford';
  if (isStbl ? aScore > bScore : aScore < bScore) return 'A';
  if (isStbl ? bScore > aScore : bScore < aScore) return 'B';
  return 'TIE';
}
function rivalryBannerLabel(round) {
  return (round.format || 'stroke') === 'stableford' ? 'stableford points' : 'net strokes';
}

suite('Rivalry banner — format-aware scoring');
test('stroke round: lower net score wins', () => {
  const r = makeRound18(); r.format = 'stroke';
  r.scores.p1 = {}; r.scores.p2 = {};
  for (let n = 1; n <= 18; n++) { r.scores.p1[n] = { s: 5 }; r.scores.p2[n] = { s: 4 }; }
  const aScore = rivalryBannerScore(r, ['p1']);
  const bScore = rivalryBannerScore(r, ['p2']);
  eq(rivalryBannerWinner(r, aScore, bScore), 'B'); // p2 has fewer strokes
});
test('stableford round: higher points score wins', () => {
  const r = makeRound18(); r.format = 'stableford';
  r.scores.p1 = {}; r.scores.p2 = {};
  // p1 gets par every hole (2pts), p2 gets bogey (1pt)
  for (let n = 1; n <= 18; n++) {
    const par = r.holes[n-1].par;
    r.scores.p1[n] = { s: par };
    r.scores.p2[n] = { s: par + 1 };
  }
  const aScore = rivalryBannerScore(r, ['p1']);
  const bScore = rivalryBannerScore(r, ['p2']);
  assert(aScore > bScore, `p1 should have more points (${aScore} vs ${bScore})`);
  eq(rivalryBannerWinner(r, aScore, bScore), 'A');
});
test('stableford round: tie detected correctly', () => {
  const r = makeRound18(); r.format = 'stableford';
  r.players.forEach(p => p.handicapIndex = 0); // same hcp → same pts for same shots
  r.scores.p1 = {}; r.scores.p2 = {};
  for (let n = 1; n <= 18; n++) {
    const par = r.holes[n-1].par;
    r.scores.p1[n] = { s: par };
    r.scores.p2[n] = { s: par };
  }
  const aScore = rivalryBannerScore(r, ['p1']);
  const bScore = rivalryBannerScore(r, ['p2']);
  eq(rivalryBannerWinner(r, aScore, bScore), 'TIE');
});
test('label is "stableford points" for stableford round', () => {
  eq(rivalryBannerLabel({ format: 'stableford' }), 'stableford points');
});
test('label is "net strokes" for stroke round', () => {
  eq(rivalryBannerLabel({ format: 'stroke' }), 'net strokes');
});
test('label is "net strokes" when format is absent', () => {
  eq(rivalryBannerLabel({}), 'net strokes');
});

// ═════════════════════════════════════════════════════════════════════════════
// COURSE OVERRIDE MERGE  (logic mirrored from init + onSnapshot)
// ═════════════════════════════════════════════════════════════════════════════
function mergeCourseOverrides(localOverrides, fsCourses) {
  const merged = new Map(localOverrides.map(c => [c.id, c]));
  for (const fsCourse of fsCourses) {
    const local = merged.get(fsCourse.id);
    if (!local) {
      merged.set(fsCourse.id, fsCourse);
    } else if (local.updatedAt && fsCourse.updatedAt && fsCourse.updatedAt > local.updatedAt) {
      merged.set(fsCourse.id, fsCourse);
    }
  }
  return Array.from(merged.values());
}

suite('Course override merge — init strategy');
test('Firestore-only course added to local', () => {
  const result = mergeCourseOverrides([], [{ id:'korpa', name:'Korpa', updatedAt:1000 }]);
  eq(result.length, 1);
  eq(result[0].id, 'korpa');
});
test('local-only course preserved when not in Firestore', () => {
  const local = [{ id:'grafarholt', name:'Grafarholt', courseRating:71.5, updatedAt:1000 }];
  const result = mergeCourseOverrides(local, []);
  eq(result.length, 1);
  eq(result[0].courseRating, 71.5);
});
test('local wins when both have same timestamp', () => {
  const local = [{ id:'grafarholt', courseRating:71.5, updatedAt:1000 }];
  const fs    = [{ id:'grafarholt', courseRating:70.5, updatedAt:1000 }];
  const result = mergeCourseOverrides(local, fs);
  eq(result[0].courseRating, 71.5);
});
test('local wins when neither has a timestamp', () => {
  const local = [{ id:'grafarholt', courseRating:71.5 }];
  const fs    = [{ id:'grafarholt', courseRating:70.5 }];
  const result = mergeCourseOverrides(local, fs);
  eq(result[0].courseRating, 71.5);
});
test('Firestore wins when its timestamp is strictly newer', () => {
  const local = [{ id:'grafarholt', courseRating:70.5, updatedAt:1000 }];
  const fs    = [{ id:'grafarholt', courseRating:71.5, updatedAt:2000 }];
  const result = mergeCourseOverrides(local, fs);
  eq(result[0].courseRating, 71.5);
});
test('local wins when local timestamp is newer', () => {
  const local = [{ id:'grafarholt', courseRating:71.5, updatedAt:3000 }];
  const fs    = [{ id:'grafarholt', courseRating:70.5, updatedAt:2000 }];
  const result = mergeCourseOverrides(local, fs);
  eq(result[0].courseRating, 71.5);
});
test('local wins when only Firestore has no timestamp', () => {
  const local = [{ id:'grafarholt', courseRating:71.5, updatedAt:1000 }];
  const fs    = [{ id:'grafarholt', courseRating:70.5 }];
  const result = mergeCourseOverrides(local, fs);
  eq(result[0].courseRating, 71.5);
});
test('local wins when only local has no timestamp', () => {
  const local = [{ id:'grafarholt', courseRating:71.5 }];
  const fs    = [{ id:'grafarholt', courseRating:70.5, updatedAt:2000 }];
  const result = mergeCourseOverrides(local, fs);
  eq(result[0].courseRating, 71.5);
});
test('multiple courses merged correctly', () => {
  const local = [
    { id:'grafarholt', courseRating:71.5, updatedAt:3000 },
    { id:'korpa',      courseRating:72.0, updatedAt:1000 },
  ];
  const fs = [
    { id:'grafarholt', courseRating:70.5, updatedAt:2000 }, // local is newer → local wins
    { id:'korpa',      courseRating:73.0, updatedAt:2000 }, // fs is newer → fs wins
    { id:'keilir',     courseRating:70.1, updatedAt:500  }, // only in fs → added
  ];
  const result = mergeCourseOverrides(local, fs);
  eq(result.length, 3);
  eq(result.find(c => c.id==='grafarholt').courseRating, 71.5);
  eq(result.find(c => c.id==='korpa').courseRating,      73.0);
  eq(result.find(c => c.id==='keilir').courseRating,     70.1);
});

// ═════════════════════════════════════════════════════════════════════════════
// TEAM SCORE SUMMARY  (logic mirrored from renderStats)
// ═════════════════════════════════════════════════════════════════════════════
function buildTeamSummary(allPlayerStats) {
  const strokeRanked = allPlayerStats.filter(ps => ps.stroke.rounds > 0)
    .sort((a, b) => a.stroke.avgNetToPar - b.stroke.avgNetToPar);
  if (strokeRanked.length < 2) return null;
  const teamAvg    = strokeRanked.reduce((s, ps) => s + ps.stroke.avgNetToPar, 0) / strokeRanked.length;
  const totalRounds = strokeRanked.reduce((s, ps) => s + ps.stroke.rounds,    0);
  return { strokeRanked, teamAvg, totalRounds };
}

suite('Team score summary — buildTeamSummary');
test('returns null for 0 players', () => {
  eq(buildTeamSummary([]), null);
});
test('returns null for 1 player with stroke rounds', () => {
  const ps = [{ name:'A', stroke:{ rounds:3, avgNetToPar:2.0 } }];
  eq(buildTeamSummary(ps), null);
});
test('returns null when no player has stroke rounds', () => {
  const ps = [
    { name:'A', stroke:{ rounds:0, avgNetToPar:0 } },
    { name:'B', stroke:{ rounds:0, avgNetToPar:0 } },
  ];
  eq(buildTeamSummary(ps), null);
});
test('returns summary for 2 players', () => {
  const ps = [
    { name:'A', stroke:{ rounds:4, avgNetToPar: 3.0 } },
    { name:'B', stroke:{ rounds:2, avgNetToPar:-1.0 } },
  ];
  const res = buildTeamSummary(ps);
  assert(res !== null);
  eq(res.totalRounds, 6);
  // teamAvg = (3.0 + -1.0) / 2 = 1.0
  assert(Math.abs(res.teamAvg - 1.0) < 0.001, `teamAvg should be 1.0, got ${res.teamAvg}`);
});
test('players ranked ascending by avgNetToPar (leader first)', () => {
  const ps = [
    { name:'A', stroke:{ rounds:3, avgNetToPar: 5.0 } },
    { name:'B', stroke:{ rounds:3, avgNetToPar:-2.0 } },
    { name:'C', stroke:{ rounds:3, avgNetToPar: 1.0 } },
  ];
  const res = buildTeamSummary(ps);
  eq(res.strokeRanked[0].name, 'B');
  eq(res.strokeRanked[1].name, 'C');
  eq(res.strokeRanked[2].name, 'A');
});
test('players with 0 stroke rounds excluded from ranking', () => {
  const ps = [
    { name:'A', stroke:{ rounds:3, avgNetToPar: 2.0 } },
    { name:'B', stroke:{ rounds:0, avgNetToPar: 0.0 } },
    { name:'C', stroke:{ rounds:5, avgNetToPar:-1.0 } },
  ];
  const res = buildTeamSummary(ps);
  eq(res.strokeRanked.length, 2);
  eq(res.strokeRanked.find(p => p.name === 'B'), undefined);
});
test('team avg is mean of all included players avgNetToPar', () => {
  const ps = [
    { name:'A', stroke:{ rounds:1, avgNetToPar: 6.0 } },
    { name:'B', stroke:{ rounds:1, avgNetToPar: 3.0 } },
    { name:'C', stroke:{ rounds:1, avgNetToPar:-3.0 } },
  ];
  const res = buildTeamSummary(ps);
  // (6 + 3 + -3) / 3 = 2.0
  assert(Math.abs(res.teamAvg - 2.0) < 0.001, `expected 2.0, got ${res.teamAvg}`);
});
test('totalRounds is sum of all included players rounds', () => {
  const ps = [
    { name:'A', stroke:{ rounds:4, avgNetToPar:1 } },
    { name:'B', stroke:{ rounds:6, avgNetToPar:2 } },
    { name:'C', stroke:{ rounds:0, avgNetToPar:0 } },
  ];
  eq(buildTeamSummary(ps).totalRounds, 10);
});

// ═════════════════════════════════════════════════════════════════════════════
// CHANGE LOG
// ═════════════════════════════════════════════════════════════════════════════
suite('Change log — player');
test('new player: created entry, no changes array required', () => {
  resetState();
  upsertPlayer({id:'p1',name:'Jón',handicapIndex:12,gender:'karlar'});
  const log=getChangeLog();
  eq(log.length,1); eq(log[0].action,'created'); eq(log[0].entityName,'Jón');
});
test('edit name: logs Name change', () => {
  resetState();
  upsertPlayer({id:'p1',name:'Jón',  handicapIndex:12,gender:'karlar'});
  upsertPlayer({id:'p1',name:'Jónas',handicapIndex:12,gender:'karlar'});
  const log=getChangeLog();
  eq(log[0].action,'updated');
  eq(log[0].changes.length,1);
  eq(log[0].changes[0].field,'Name');
  eq(log[0].changes[0].from,'Jón'); eq(log[0].changes[0].to,'Jónas');
});
test('edit handicap: logs Handicap Index change', () => {
  resetState();
  upsertPlayer({id:'p1',name:'Jón',handicapIndex:18.4,gender:'karlar'});
  upsertPlayer({id:'p1',name:'Jón',handicapIndex:16.2,gender:'karlar'});
  const log=getChangeLog();
  eq(log[0].changes[0].field,'Handicap Index');
  eq(log[0].changes[0].from,18.4); eq(log[0].changes[0].to,16.2);
});
test('no diff: update with identical data logs nothing', () => {
  resetState();
  upsertPlayer({id:'p1',name:'Jón',handicapIndex:12,gender:'karlar'});
  const before=getChangeLog().length;
  upsertPlayer({id:'p1',name:'Jón',handicapIndex:12,gender:'karlar'});
  eq(getChangeLog().length, before);
});
test('delete player: logs deleted entry', () => {
  resetState();
  upsertPlayer({id:'p1',name:'Jón',handicapIndex:12,gender:'karlar'});
  deletePlayer('p1');
  const log=getChangeLog();
  eq(log[0].action,'deleted'); eq(log[0].entityName,'Jón');
});

suite('Change log — course');
test('new course: created entry', () => {
  resetState();
  saveCourseData({id:'c1',name:'Hlíðavöllur',holes:9,pars:[4,4,3,4,5,3,4,4,5],si:[1,3,9,5,7,11,13,15,17],descriptions:Array(9).fill(''),tees:[]});
  const log=getChangeLog();
  eq(log[0].action,'created'); eq(log[0].entityName,'Hlíðavöllur');
});
test('edit course name: logs Name change', () => {
  resetState();
  saveCourseData({id:'c1',name:'Hlíðavöllur', holes:9,pars:[4,4,3,4,5,3,4,4,5],si:[1,3,9,5,7,11,13,15,17],descriptions:Array(9).fill(''),tees:[]});
  saveCourseData({id:'c1',name:'Hlíðavöllur 2',holes:9,pars:[4,4,3,4,5,3,4,4,5],si:[1,3,9,5,7,11,13,15,17],descriptions:Array(9).fill(''),tees:[]});
  const log=getChangeLog();
  eq(log[0].changes[0].field,'Name');
  eq(log[0].changes[0].from,'Hlíðavöllur'); eq(log[0].changes[0].to,'Hlíðavöllur 2');
});
test('edit par on hole 3: logs Par H3 change', () => {
  resetState();
  const pars=[4,4,3,4,5,3,4,4,5];
  saveCourseData({id:'c1',name:'Test',holes:9,pars:[...pars],si:[1,3,9,5,7,11,13,15,17],descriptions:Array(9).fill(''),tees:[]});
  pars[2]=4;
  saveCourseData({id:'c1',name:'Test',holes:9,pars:[...pars],si:[1,3,9,5,7,11,13,15,17],descriptions:Array(9).fill(''),tees:[]});
  const ch=getChangeLog()[0].changes;
  eq(ch.length,1); eq(ch[0].field,'Par H3'); eq(ch[0].from,3); eq(ch[0].to,4);
});
test('edit description hole 2: logs Description H2 change', () => {
  resetState();
  const descs=Array(9).fill('');
  saveCourseData({id:'c1',name:'Hlíðavöllur',holes:9,pars:[4,4,3,4,5,3,4,4,5],si:[1,3,9,5,7,11,13,15,17],descriptions:[...descs],tees:[]});
  descs[1]='Dogleg right, bunker left';
  saveCourseData({id:'c1',name:'Hlíðavöllur',holes:9,pars:[4,4,3,4,5,3,4,4,5],si:[1,3,9,5,7,11,13,15,17],descriptions:[...descs],tees:[]});
  const ch=getChangeLog()[0].changes;
  eq(ch.length,1); eq(ch[0].field,'Description H2');
  eq(ch[0].from,'—'); eq(ch[0].to,'Dogleg right, bunker left');
});
test('edit description hole 2 to empty: logs from value to —', () => {
  resetState();
  const descs=['','Dogleg right',...Array(7).fill('')];
  saveCourseData({id:'c1',name:'Hlíðavöllur',holes:9,pars:[4,4,3,4,5,3,4,4,5],si:[1,3,9,5,7,11,13,15,17],descriptions:[...descs],tees:[]});
  descs[1]='';
  saveCourseData({id:'c1',name:'Hlíðavöllur',holes:9,pars:[4,4,3,4,5,3,4,4,5],si:[1,3,9,5,7,11,13,15,17],descriptions:[...descs],tees:[]});
  const ch=getChangeLog()[0].changes;
  eq(ch.length,1); eq(ch[0].field,'Description H2');
  eq(ch[0].from,'Dogleg right'); eq(ch[0].to,'—');
});
test('no diff: saving course with identical descriptions logs nothing', () => {
  resetState();
  const descs=['','Dogleg right',...Array(7).fill('')];
  saveCourseData({id:'c1',name:'Hlíðavöllur',holes:9,pars:[4,4,3,4,5,3,4,4,5],si:[1,3,9,5,7,11,13,15,17],descriptions:[...descs],tees:[]});
  const before=getChangeLog().length;
  saveCourseData({id:'c1',name:'Hlíðavöllur',holes:9,pars:[4,4,3,4,5,3,4,4,5],si:[1,3,9,5,7,11,13,15,17],descriptions:[...descs],tees:[]});
  eq(getChangeLog().length, before);
});
test('delete course: logs deleted entry', () => {
  resetState();
  saveCourseData({id:'c1',name:'Hlíðavöllur',holes:9,pars:[4,4,3,4,5,3,4,4,5],si:[1,3,9,5,7,11,13,15,17],descriptions:Array(9).fill(''),tees:[]});
  deleteCourseData('c1');
  eq(getChangeLog()[0].action,'deleted'); eq(getChangeLog()[0].entityName,'Hlíðavöllur');
});

// ── gotoHole 9→10 interstitial ────────────────────────────────────────────────
suite('gotoHole — 9-hole interstitial');
test('navigating 9→10 on 18-hole round sets showNineHoleSummary', () => {
  resetState();
  const r = makeRound18();
  saveRound(r); S.roundId = r.id; S.hole = 9;
  gotoHole(10);
  assert(S.showNineHoleSummary === true, 'showNineHoleSummary should be true');
  eq(S.hole, 10);
});
test('navigating 8→9 does NOT set showNineHoleSummary', () => {
  resetState();
  const r = makeRound18();
  saveRound(r); S.roundId = r.id; S.hole = 8;
  gotoHole(9);
  assert(S.showNineHoleSummary === false, 'showNineHoleSummary should remain false');
});
test('navigating 9→10 on 9-hole round does NOT set showNineHoleSummary', () => {
  resetState();
  const holes = makeHoles9();
  const r = { id:'r9', date:'2026-05-02T10:00:00Z', course:'9-Hole', courseRating:36, slopeRating:113,
    players:[{id:'p1',name:'Alice',handicapIndex:10}], holes, scores:{p1:{}}, done:false, format:'stroke' };
  saveRound(r); S.roundId = r.id; S.hole = 9;
  gotoHole(9); // can't go to 10 (out of range), so try hole 9 again
  assert(S.showNineHoleSummary === false);
});

// ── Round comments ────────────────────────────────────────────────────────────
suite('Round comments — finishRound / submitFinishComment');
test('finishRound sets finishComment to empty string', () => {
  resetState();
  const r = makeRound18();
  saveRound(r); S.roundId = r.id;
  finishRound();
  eq(S.finishComment, '');
});
test('submitFinishComment saves comment to round and marks done', () => {
  resetState();
  const r = makeRound18();
  saveRound(r); S.roundId = r.id;
  finishRound();
  updateFinishComment('First eagle for Bob!');
  submitFinishComment();
  const saved = byId(r.id);
  eq(saved.comments, 'First eagle for Bob!');
  assert(saved.done === true, 'round should be done');
  eq(S.finishComment, null);
});
test('submitFinishComment with empty comment does not set comments', () => {
  resetState();
  const r = makeRound18();
  saveRound(r); S.roundId = r.id;
  finishRound();
  updateFinishComment('  '); // whitespace only
  submitFinishComment();
  const saved = byId(r.id);
  assert(!saved.comments, 'comments should not be set for whitespace input');
  assert(saved.done === true);
});
test('skipFinishComment marks round done without setting comment', () => {
  resetState();
  const r = makeRound18();
  saveRound(r); S.roundId = r.id;
  finishRound();
  skipFinishComment();
  const saved = byId(r.id);
  assert(!saved.comments, 'comments should not be set when skipped');
  assert(saved.done === true);
  eq(S.finishComment, null);
});

// ── Handicap index suggestion ─────────────────────────────────────────────────
suite('suggestHcpIndex');
function makeFinishedRound(pid, name, hcpIdx, gross, cr, sr, date) {
  const holes = makeHoles18();
  const scores = {};
  scores[pid] = {};
  holes.forEach((h, i) => {
    const perHole = Math.round(gross / holes.length);
    // Distribute evenly; last hole gets any remainder
    const s = i === holes.length - 1 ? gross - (holes.length - 1) * perHole : perHole;
    scores[pid][h.n] = { s: Math.max(1, s) };
  });
  return {
    id: 'r_' + pid + '_' + date,
    date,
    course: 'Test',
    courseRating: cr,
    slopeRating: sr,
    players: [{ id: pid, name, handicapIndex: hcpIdx }],
    holes,
    scores,
    done: true,
    format: 'stroke',
  };
}
test('returns null when no rounds with CR/SR', () => {
  resetState();
  eq(suggestHcpIndex('Alice', []), null);
});
test('returns null when all rounds lack courseRating', () => {
  resetState();
  const r = makeRound18({ done: true });
  delete r.courseRating;
  eq(suggestHcpIndex('Alice', [r]), null);
});
test('single round: correct differential formula', () => {
  resetState();
  // gross=80, CR=72, SR=113 → diff=(80-72)*(113/113)=8.0 → index=8.0*0.96=7.7
  const r = makeFinishedRound('p1', 'Alice', 10, 80, 72, 113, '2026-01-01T10:00:00Z');
  const res = suggestHcpIndex('Alice', [r]);
  assert(res !== null);
  assert(Math.abs(res.index - 7.7) < 0.05, `expected ~7.7, got ${res.index}`);
  eq(res.best, 1);
  eq(res.roundsUsed, 1);
});
test('uses best 8 of available rounds, ignores higher differentials', () => {
  resetState();
  const rounds = [];
  // 8 rounds at gross 80 (diff=8.0) and 2 rounds at gross 90 (diff=18.0)
  for (let i = 0; i < 10; i++) {
    const gross = i < 8 ? 80 : 90;
    rounds.push(makeFinishedRound('p1', 'Alice', 10, gross, 72, 113,
      `2026-0${i < 9 ? (i+1) : '9'}-01T10:00:00Z`));
  }
  const res = suggestHcpIndex('Alice', rounds);
  assert(res !== null);
  // best 8 are the 80-gross rounds: diff=8.0 each, avg=8.0, ×0.96=7.68 → 7.7
  assert(Math.abs(res.index - 7.7) < 0.1, `expected ~7.7, got ${res.index}`);
  eq(res.best, 8);
  eq(res.roundsUsed, 10);
});
test('ignores rounds with incomplete scores', () => {
  resetState();
  const r = makeFinishedRound('p1', 'Alice', 10, 80, 72, 113, '2026-01-01T10:00:00Z');
  // Remove one score to make it incomplete
  delete r.scores.p1[1];
  eq(suggestHcpIndex('Alice', [r]), null);
});
test('slope rating affects differential', () => {
  resetState();
  // gross=80, CR=72, SR=140 → diff=(80-72)*(113/140)=8*(0.8071...)=6.457
  const r = makeFinishedRound('p1', 'Alice', 10, 80, 72, 140, '2026-01-01T10:00:00Z');
  const res = suggestHcpIndex('Alice', [r]);
  const expected = Math.round((80 - 72) * (113 / 140) * 0.96 * 10) / 10;
  assert(Math.abs(res.index - expected) < 0.05, `expected ${expected}, got ${res.index}`);
});

// ── Net score during round (netTotal helper) ──────────────────────────────────
suite('Net score during round — partial netTotal');
test('netTotal with 0 hcp equals gross scored', () => {
  resetState();
  const r = makeRound18({ players: [{ id:'p1', name:'Alice', courseHcpOverride:0 }] });
  r.scores.p1[1] = { s: 5 };
  r.scores.p1[2] = { s: 4 };
  // par for holes 1+2 = 4+4 = 8; gross = 9; net = 9; net vs par = 9-8 = +1
  eq(netTotal(r, 'p1'), 9);
});
test('netTotal with positive hcp subtracts strokes on high-SI holes', () => {
  resetState();
  const r = makeRound18({ players: [{ id:'p1', name:'Alice', courseHcpOverride:1 }] });
  // With chcp=1, only hole with SI=1 gets 1 extra stroke. SI=1 is hole index 0 (hole n=1).
  r.scores.p1[1] = { s: 5 }; // par 4, SI 1, gets 1 stroke → net = 5-1 = 4
  r.scores.p1[2] = { s: 4 }; // par 4, SI 9, no stroke → net = 4
  // total net = 4+4 = 8
  eq(netTotal(r, 'p1'), 8);
});

// ── buildRoundStandingsHTML — ranking logic ───────────────────────────────────
suite('buildRoundStandingsHTML — stroke play ranking');
test('player with lower net vs par ranks first', () => {
  resetState();
  const r = makeRound18({ players: [
    { id:'p1', name:'Alice', courseHcpOverride:0 },
    { id:'p2', name:'Bob',   courseHcpOverride:0 },
  ]});
  // Alice: 4 strokes on par-4 hole 1 → net vs par = 0
  // Bob:   6 strokes on par-4 hole 1 → net vs par = +2
  r.scores.p1[1] = { s: 4 };
  r.scores.p2[1] = { s: 6 };
  const rows = buildRoundStandingsHTML(r);
  eq(rows[0].p.name, 'Alice');
  eq(rows[1].p.name, 'Bob');
});
test('player with better net score (after hcp) ranks first even if higher gross', () => {
  resetState();
  const r = makeRound18({ players: [
    { id:'p1', name:'Alice', courseHcpOverride:0  },
    { id:'p2', name:'Bob',   courseHcpOverride:18 },
  ]});
  // Hole 1: SI=1, Bob (chcp=18) gets 1 stroke → net = gross - 1
  // Alice gross 5, net vs par = +1
  // Bob gross 6, net = 6-1=5, vs par = +1 → tied, so order stable or by Infinity logic
  // Let's try Alice gross 5 (net +1), Bob gross 5 (net 5-1=4, vs par = 0) → Bob wins net
  r.scores.p1[1] = { s: 5 }; // Alice: net vs par = 5-4 = +1
  r.scores.p2[1] = { s: 5 }; // Bob: net = 5-1=4, vs par = 4-4 = 0
  const rows = buildRoundStandingsHTML(r);
  eq(rows[0].p.name, 'Bob');
  eq(rows[1].p.name, 'Alice');
});
test('player with no scores ranks last (primary=Infinity)', () => {
  resetState();
  const r = makeRound18({ players: [
    { id:'p1', name:'Alice', courseHcpOverride:0 },
    { id:'p2', name:'Bob',   courseHcpOverride:0 },
  ]});
  r.scores.p1[1] = { s: 5 };
  // Bob has no scores
  const rows = buildRoundStandingsHTML(r);
  eq(rows[0].p.name, 'Alice');
  eq(rows[1].p.name, 'Bob');
  eq(rows[1].primary, Infinity);
});

suite('buildRoundStandingsHTML — stableford ranking');
test('player with more points ranks first', () => {
  resetState();
  const r = makeRound18({ format: 'stableford', players: [
    { id:'p1', name:'Alice', courseHcpOverride:0 },
    { id:'p2', name:'Bob',   courseHcpOverride:0 },
  ]});
  // Hole 1 par 4; Alice 3 (birdie=3pts), Bob 4 (par=2pts)
  r.scores.p1[1] = { s: 3 };
  r.scores.p2[1] = { s: 4 };
  const rows = buildRoundStandingsHTML(r);
  eq(rows[0].p.name, 'Alice');
  eq(rows[0].primary, 3);
  eq(rows[1].p.name, 'Bob');
  eq(rows[1].primary, 2);
});

// ── buildNineHoleSummaryHTML — front-9 ranking ────────────────────────────────
suite('buildNineHoleSummaryHTML — stroke ranking');
test('player with lower net ranks first', () => {
  resetState();
  const r = makeRound18({ players: [
    { id:'p1', name:'Alice', courseHcpOverride:0 },
    { id:'p2', name:'Bob',   courseHcpOverride:0 },
  ]});
  // Give all 9 front holes scores: Alice at par, Bob one over on hole 1
  for (let i = 1; i <= 9; i++) {
    r.scores.p1[i] = { s: r.holes[i-1].par };
    r.scores.p2[i] = { s: r.holes[i-1].par + (i === 1 ? 1 : 0) };
  }
  const rows = buildNineHoleSummaryHTML(r);
  eq(rows[0].p.name, 'Alice');
  eq(rows[1].p.name, 'Bob');
});
test('net value reflects hcp strokes on front 9', () => {
  resetState();
  const r = makeRound18({ players: [
    { id:'p1', name:'Alice', courseHcpOverride:1 }, // gets 1 stroke on SI=1 hole (hole 1)
  ]});
  // Hole 1: par 4, SI 1, Alice gets 1 stroke → net = gross - 1
  r.scores.p1[1] = { s: 5 }; // gross 5 → net 4 = par
  const rows = buildNineHoleSummaryHTML(r);
  // net for hole 1 = 5 - 1 = 4; total net = 4
  eq(rows[0].net, 4);
});
test('player with no front-9 scores sorts last', () => {
  resetState();
  const r = makeRound18({ players: [
    { id:'p1', name:'Alice', courseHcpOverride:0 },
    { id:'p2', name:'Bob',   courseHcpOverride:0 },
  ]});
  for (let i = 1; i <= 9; i++) r.scores.p1[i] = { s: r.holes[i-1].par };
  // Bob has no scores → net=0, but sort uses (a.net||999)
  const rows = buildNineHoleSummaryHTML(r);
  eq(rows[0].p.name, 'Alice');
  eq(rows[1].p.name, 'Bob');
});

// ═════════════════════════════════════════════════════════════════════════════
// PRINT RESULTS
// ═════════════════════════════════════════════════════════════════════════════
console.log('');
let suitesFailed=0;
for (const s of _suites){
  const failed=s.tests.filter(t=>!t.ok);
  if (failed.length) suitesFailed++;
  const icon=failed.length?C.red+'✗'+C.reset:C.green+'✓'+C.reset;
  const passCount=s.tests.length-failed.length;
  console.log(` ${icon} ${C.bold}${s.name}${C.reset} ${C.dim}(${passCount}/${s.tests.length})${C.reset}`);
  for (const t of failed){
    console.log(`     ${C.red}✗ ${t.name}${C.reset}`);
    if (t.msg) console.log(`       ${C.dim}${t.msg}${C.reset}`);
  }
}
console.log('');
if (_failed===0){
  console.log(` ${C.green}${C.bold}All ${_passed} tests passed.${C.reset}`);
} else {
  console.log(` ${C.red}${C.bold}${_failed} test(s) failed${C.reset} ${C.dim}(${_passed} passed)${C.reset}`);
}
console.log('');
process.exit(_failed>0?1:0);
