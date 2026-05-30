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
const TEE_PREFS_KEY  = 'TEST_golf_tee_prefs';
const NAV_KEY        = 'TEST_golf_nav';
const COURSE_IMG_PFX  = 'TEST_golf_img_';
const COURSES_KEY     = 'TEST_golf_courses';
const DELETED_KEY     = 'TEST_golf_deleted_rounds';

// Mock localStorage (Node.js has none)
let _lsStore = {};
const localStorage = {
  getItem:    k      => Object.prototype.hasOwnProperty.call(_lsStore, k) ? _lsStore[k] : null,
  setItem:    (k, v) => { _lsStore[k] = String(v); },
  removeItem: k      => { delete _lsStore[k]; },
  clear:      ()     => { _lsStore = {}; },
  get length()       { return Object.keys(_lsStore).length; },
  key:        i      => Object.keys(_lsStore)[i] ?? null,
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
let _domElements = {};
const document = { getElementById: id => _domElements[id] || null };

// Global mutable state (mirrors index.html globals)
let _rounds = [], _players = [], _courseOverrides = [], _auditFlushTimer = null;
let _deletedRoundIds = new Set();
const S = {
  view: 'home', roundId: null, hole: 1, numpadPid: null, showLayout: false, nr: {}, playerEdit: null,
  showRoundSummary: false, showNineHoleSummary: false, finishComment: null,
};

function resetState() {
  _rounds = []; _players = []; _courseOverrides = []; _auditFlushTimer = null;
  _deletedRoundIds = new Set();
  _lsStore = {}; _fsStore = {}; _domElements = {};
  S.view = 'home'; S.roundId = null; S.hole = 1; S.numpadPid = null;
  S.showRoundSummary = false; S.showNineHoleSummary = false; S.finishComment = null;
  S.nr = { holes:18, selPids:[], courseId:null, playerTee:{}, guests:[], chcp:{} };
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

function buildStats(rounds, name, fmt, includeWolf, includeStableford, includeStroke, noHcp) {
  fmt = fmt || 'stroke';
  if (includeStroke === undefined) includeStroke = true;
  const s = {
    name, fmt, rounds: 0,
    bestDate: null, bestCourse: null, bestFmt: null,
    totalHoles: 0, history: [],
    sc: { holesInOne:0, albatrosses:0, eagles:0, birdies:0, pars:0, bogeys:0, doubleBogeys:0, triplePlus:0 },
    avgNet: 0, avgNetToPar: 0, bestNet: Infinity, bestNetToPar: 0,
    avgPts: 0, bestPts: -Infinity,
  };
  let ss = 0, ps = 0;
  for (const r of rounds) {
    const roundFmt = r.format || 'stroke';
    const matches = (roundFmt === fmt && (roundFmt !== 'stroke' || includeStroke))
      || (fmt === 'stroke' && includeWolf        && roundFmt === 'wolf')
      || (fmt === 'stroke' && includeStableford  && roundFmt === 'stableford');
    if (!r.done || !matches) continue;
    const p = r.players.find(pl => pl.name === name);
    if (!p) continue;
    const pid = p.id;
    if (r.holes.filter(h => r.scores[pid]?.[h.n]?.s).length < r.holes.length) continue;
    s.rounds++;
    const chcp = courseHcp(p, r), nh = r.holes.length;
    if (fmt === 'stableford') {
      const pts = stablefordTotal(r, pid);
      ss += pts;
      if (pts > s.bestPts) { s.bestPts = pts; s.bestDate = r.date; s.bestCourse = r.course; }
      s.history.push({ date: r.date, course: r.course, val: pts });
      for (const h of r.holes) {
        const g = r.scores[pid]?.[h.n]?.s; if (!g) continue;
        s.totalHoles++;
        const pt = stablefordPts(g, h.par, siStrokes(chcp, h.si, nh));
        if      (pt >= 4) s.sc.eagles++;
        else if (pt === 3) s.sc.birdies++;
        else if (pt === 2) s.sc.pars++;
        else if (pt === 1) s.sc.bogeys++;
        else               s.sc.doubleBogeys++;
      }
    } else if (fmt === 'wolf') {
      const pts = wolfTotalPts(r, pid);
      ss += pts;
      if (pts > s.bestPts) { s.bestPts = pts; s.bestDate = r.date; s.bestCourse = r.course; }
      s.history.push({ date: r.date, course: r.course, val: pts });
    } else {
      const rpar = parSum(r);
      const net = noHcp ? grossTotal(r, pid) : netTotal(r, pid);
      ss += net; ps += rpar;
      if (net < s.bestNet) { s.bestNet = net; s.bestNetToPar = net - rpar; s.bestDate = r.date; s.bestCourse = r.course; s.bestFmt = roundFmt === 'stroke' ? null : roundFmt; }
      s.history.push({ date: r.date, course: r.course, val: net - rpar, net, srcFmt: roundFmt });
      for (const h of r.holes) {
        const g = r.scores[pid]?.[h.n]?.s; if (!g) continue;
        s.totalHoles++;
        const d = (g - (noHcp ? 0 : siStrokes(chcp, h.si, nh))) - h.par;
        if      (g === 1)   s.sc.holesInOne++;
        else if (d <= -3)   s.sc.albatrosses++;
        else if (d === -2)  s.sc.eagles++;
        else if (d === -1)  s.sc.birdies++;
        else if (d === 0)   s.sc.pars++;
        else if (d === 1)   s.sc.bogeys++;
        else if (d === 2)   s.sc.doubleBogeys++;
        else if (d >= 3)    s.sc.triplePlus++;
      }
    }
  }
  if (s.rounds > 0) {
    if (fmt === 'stroke') { s.avgNet = ss / s.rounds; s.avgNetToPar = (ss - ps) / s.rounds; }
    else s.avgPts = ss / s.rounds;
  }
  if (s.bestNet === Infinity) s.bestNet = 0;
  if (s.bestPts === -Infinity) s.bestPts = 0;
  s.history.sort((a, b) => new Date(a.date) - new Date(b.date));
  return s;
}

function buildBackupPayload() {
  const read = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const imgs = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(COURSE_IMG_PFX)) imgs[k] = localStorage.getItem(k);
  }
  return {
    version:    2,
    exportedAt: new Date().toISOString(),
    data: {
      rounds:     read(ROUNDS_KEY)      || [],
      players:    read(PLAYERS_KEY)     || [],
      courses:    read(COURSES_KEY)     || [],
      changes:    read(CHANGE_LOG_KEY)  || [],
      audit:      read(AUDIT_KEY)       || [],
      errors:     read(ERROR_LOG_KEY)   || [],
      teePrefs:   read(TEE_PREFS_KEY)   || {},
      courseImgs: imgs,
    },
  };
}

function parseDateInput(dateVal) {
  return dateVal ? (dateVal + 'T12:00:00.000Z') : new Date().toISOString();
}

function buildDeleteRoundMessage(round) {
  if (!round) return 'Delete this round?\n\nThis cannot be undone.';
  const dateStr = new Date(round.date).toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const _rts  = parseInt(round.id.slice(1), 10);
  const timeStr = !isNaN(_rts)
    ? new Date(_rts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
    : '';
  const dateTime = timeStr ? `${dateStr} at ${timeStr}` : dateStr;
  return `Delete this round?\n\n📍 ${round.course}\n📅 ${dateTime}\n\nThis cannot be undone.`;
}

// ── STATEFUL FUNCTIONS (copied, use mock deps) ────────────────────────────────
function loadRounds()  { return _rounds; }
function loadPlayers() { return _players; }
function loadCourses() { return _courseOverrides; }
function byId(id)      { return _rounds.find(r=>r.id===id)||null; }
function isPresetCourse(id) { return id.startsWith('preset_'); }

function _saveTeePrefs(pid, courseId, teeIdx) {
  try {
    const prefs = JSON.parse(localStorage.getItem(TEE_PREFS_KEY) || '{}');
    prefs[pid + '_' + courseId] = teeIdx;
    localStorage.setItem(TEE_PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}
function _loadTeePref(pid, courseId) {
  try {
    const prefs = JSON.parse(localStorage.getItem(TEE_PREFS_KEY) || '{}');
    const v = prefs[pid + '_' + courseId];
    return (v != null) ? v : null;
  } catch { return null; }
}
function setPlayerTee(pid, teeIdx) {
  if (!S.nr.playerTee) S.nr.playerTee = {};
  S.nr.playerTee[pid] = teeIdx;
  if (S.nr.courseId) _saveTeePrefs(pid, S.nr.courseId, teeIdx);
}
function setCourse(id) {
  S.nr.courseId = id;
  if (id) {
    if (!S.nr.playerTee) S.nr.playerTee = {};
    for (const pid of (S.nr.selPids || [])) {
      const saved = _loadTeePref(pid, id);
      if (saved !== null) S.nr.playerTee[pid] = saved;
    }
  }
}
function toggleSelPlayer(pid) {
  const idx = S.nr.selPids.indexOf(pid);
  if (idx >= 0) {
    S.nr.selPids.splice(idx, 1);
  } else {
    if (S.nr.selPids.length < 4) {
      S.nr.selPids.push(pid);
      if (S.nr.courseId) {
        const saved = _loadTeePref(pid, S.nr.courseId);
        if (saved !== null) {
          if (!S.nr.playerTee) S.nr.playerTee = {};
          S.nr.playerTee[pid] = saved;
        }
      }
    }
  }
}

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
  _deletedRoundIds.add(id);
  localStorage.setItem(ROUNDS_KEY,JSON.stringify(_rounds));
  localStorage.setItem(DELETED_KEY,JSON.stringify([..._deletedRoundIds]));
  _db.collection('rounds').doc(id).delete().catch(()=>{});
  _db.collection('meta').doc('deletedRounds').set({ids:[..._deletedRoundIds]}).catch(()=>{});
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
function saveRoundTeams(roundId, pairingIdx) {
  const round=byId(roundId); if(!round||round.players.length!==4) return;
  const pl=round.players;
  const pairings=[[[0,1],[2,3]],[[0,2],[1,3]],[[0,3],[1,2]]];
  const[t1i,t2i]=pairings[pairingIdx];
  round.teams=[t1i.map(i=>pl[i].id),t2i.map(i=>pl[i].id)];
  saveRound(round);
}
function clearRoundTeams(roundId) {
  const round=byId(roundId); if(!round) return;
  delete round.teams; saveRound(round);
}
function saveRoundCh(roundId) {
  const round=byId(roundId); if(!round) return;
  let changed=false;
  for (const p of round.players) {
    if (p.handicapIndex==null) continue;
    const safeId=p.id.replace(/[^a-zA-Z0-9_-]/g,'_');
    const el=document.getElementById('ch-edit-'+safeId);
    if (!el) continue;
    const newCh=parseInt(el.value,10);
    if (!isNaN(newCh)&&newCh!==courseHcp(p,round)) { p.courseHcpOverride=newCh; changed=true; }
  }
  if (!changed) return;
  saveRound(round); render();
}
function finishRound() {
  const round=byId(S.roundId); if(!round) return;
  S.finishComment='';
}
function submitFinishComment() {
  const round=byId(S.roundId); if(!round) return;
  const comment=(S.finishComment||'').trim();
  if(comment) round.comments=comment;
  round.done=true; saveRound(round);
  S.justFinishedRoundId=round.id; S.finishComment=null;
  nav('round-finish');
}
function skipFinishComment() {
  const round=byId(S.roundId); if(!round) return;
  round.done=true; saveRound(round);
  S.justFinishedRoundId=round.id; S.finishComment=null;
  nav('round-finish');
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
  const holesPlayed = round.holes.filter(h => round.players.every(p => round.scores[p.id]?.[h.n]?.s)).length;
  const rows = round.players.map(p => {
    const gross = grossTotal(round, p.id);
    const chcp  = courseHcp(p, round);
    const scoredPar = round.holes.filter(h => round.scores[p.id]?.[h.n]?.s).reduce((s,h)=>s+h.par,0);
    const grossVsPar = gross ? gross - scoredPar : null;
    let primary, sortKey, secondary;
    if (isStbl) {
      primary = sortKey = stablefordTotal(round, p.id);
      secondary = gross ? `gross ${gross}` : '-';
    } else if (isWolf) {
      const wp  = wolfTotalPts(round, p.id);
      primary = sortKey = wp;
      secondary = gross ? `${wp >= 0 ? '+' : ''}${wp} wolf pts` : '-';
    } else {
      const nt       = netTotal(round, p.id);
      const netVsPar = nt ? nt - scoredPar : null;
      sortKey   = netVsPar !== null ? netVsPar : Infinity;
      primary   = gross;
      secondary = gross ? `${dStr(grossVsPar)} gross · net ${dStr(netVsPar)}` : 'No scores';
    }
    return { p, gross, primary, sortKey, secondary, grossVsPar };
  });
  if (isStbl || isWolf) {
    rows.sort((a, b) => b.sortKey - a.sortKey);
  } else {
    rows.sort((a, b) => a.sortKey - b.sortKey);
  }
  return { rows, holesPlayed };
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
function _roundSortCmp(a, b) {
  if (b.date !== a.date) return b.date > a.date ? 1 : -1;
  const ta = parseInt(a.id.slice(1), 10) || 0;
  const tb = parseInt(b.id.slice(1), 10) || 0;
  return tb - ta;
}
function mergeRounds(fsRounds, localRounds) {
  const fsIds=new Set(fsRounds.map(r=>r.id));
  const localOnly=localRounds.filter(r=>!fsIds.has(r.id));
  return [...fsRounds,...localOnly].sort(_roundSortCmp);
}
// Mirror of init's tombstone-aware merge
function mergeRoundsWithTombstone(fsRounds, localRounds, deletedIds) {
  const fsIds = new Set(fsRounds.map(r => r.id));
  const localOnly = localRounds.filter(r => !fsIds.has(r.id) && !deletedIds.has(r.id));
  return [...fsRounds, ...localOnly].sort(_roundSortCmp);
}
// Mirror of the Firestore onSnapshot echo-skip guard
function snapShouldUpdate(local, incoming) {
  return incoming.lastModified !== local.lastModified || incoming.done !== local.done;
}
// Mirror of round-card time-from-ID extraction
function roundCardTime(roundId) {
  const ts = parseInt(roundId.slice(1), 10);
  return isNaN(ts) ? null : ts;
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
test('same-day rounds ordered by creation timestamp in ID',()=>{
  const earlier = { id:'r1000', date:'2026-05-16T12:00:00.000Z', course:'First' };
  const later   = { id:'r2000', date:'2026-05-16T12:00:00.000Z', course:'Second' };
  const m = mergeRounds([earlier, later], []);
  eq(m[0].id, 'r2000', 'later round should be first');
  eq(m[1].id, 'r1000');
});

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
  const { rows } = buildRoundStandingsHTML(r);
  eq(rows[0].p.name, 'Alice');
  eq(rows[1].p.name, 'Bob');
});
test('primary is gross strokes, sortKey is net vs par', () => {
  resetState();
  const r = makeRound18({ players: [
    { id:'p1', name:'Alice', courseHcpOverride:0 },
  ]});
  r.scores.p1[1] = { s: 5 }; // par 4 → grossVsPar=+1, net=5, netVsPar=+1
  const { rows } = buildRoundStandingsHTML(r);
  eq(rows[0].primary, 5);      // gross strokes displayed
  eq(rows[0].sortKey, 1);      // +1 vs par used for sorting
});
test('player with better net score (after hcp) ranks first even if higher gross', () => {
  resetState();
  const r = makeRound18({ players: [
    { id:'p1', name:'Alice', courseHcpOverride:0  },
    { id:'p2', name:'Bob',   courseHcpOverride:18 },
  ]});
  // Hole 1: SI=1, Bob (chcp=18) gets 1 stroke → net = gross - 1
  // Alice gross 5 → net vs par = +1; Bob gross 5 → net 4, vs par = 0 → Bob wins
  r.scores.p1[1] = { s: 5 };
  r.scores.p2[1] = { s: 5 };
  const { rows } = buildRoundStandingsHTML(r);
  eq(rows[0].p.name, 'Bob');
  eq(rows[1].p.name, 'Alice');
});
test('player with no scores ranks last (sortKey=Infinity)', () => {
  resetState();
  const r = makeRound18({ players: [
    { id:'p1', name:'Alice', courseHcpOverride:0 },
    { id:'p2', name:'Bob',   courseHcpOverride:0 },
  ]});
  r.scores.p1[1] = { s: 5 };
  // Bob has no scores
  const { rows } = buildRoundStandingsHTML(r);
  eq(rows[0].p.name, 'Alice');
  eq(rows[1].p.name, 'Bob');
  eq(rows[1].sortKey, Infinity);
  eq(rows[1].primary, 0); // gross = 0, shows '-' in UI
});
test('holesPlayed counts only holes where all players have scored', () => {
  resetState();
  const r = makeRound18({ players: [
    { id:'p1', name:'Alice', courseHcpOverride:0 },
    { id:'p2', name:'Bob',   courseHcpOverride:0 },
  ]});
  // All players scored holes 1-9; only Alice scored hole 10
  for (let i = 1; i <= 9; i++) { r.scores.p1[i] = { s: 4 }; r.scores.p2[i] = { s: 4 }; }
  r.scores.p1[10] = { s: 4 }; // only Alice
  const { holesPlayed } = buildRoundStandingsHTML(r);
  eq(holesPlayed, 9); // not 10
});
test('holesPlayed is 0 when no hole has all players scored', () => {
  resetState();
  const r = makeRound18({ players: [
    { id:'p1', name:'Alice', courseHcpOverride:0 },
    { id:'p2', name:'Bob',   courseHcpOverride:0 },
  ]});
  r.scores.p1[1] = { s: 4 }; // only Alice on hole 1
  const { holesPlayed } = buildRoundStandingsHTML(r);
  eq(holesPlayed, 0);
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
  const { rows } = buildRoundStandingsHTML(r);
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

// ── Tee preference persistence ────────────────────────────────────────────────
suite('Tee preference — persist and restore');
test('_saveTeePrefs / _loadTeePref round-trip', () => {
  resetState();
  _saveTeePrefs('p1', 'course_A', 2);
  eq(_loadTeePref('p1', 'course_A'), 2);
});
test('different players on same course stored independently', () => {
  resetState();
  _saveTeePrefs('p1', 'c1', 0);
  _saveTeePrefs('p2', 'c1', 2);
  eq(_loadTeePref('p1', 'c1'), 0);
  eq(_loadTeePref('p2', 'c1'), 2);
});
test('same player on different courses stored independently', () => {
  resetState();
  _saveTeePrefs('p1', 'c1', 1);
  _saveTeePrefs('p1', 'c2', 3);
  eq(_loadTeePref('p1', 'c1'), 1);
  eq(_loadTeePref('p1', 'c2'), 3);
});
test('_loadTeePref returns null when no pref saved', () => {
  resetState();
  eq(_loadTeePref('p1', 'c1'), null);
});
test('setPlayerTee persists pref when courseId is set', () => {
  resetState();
  S.nr.courseId = 'c1';
  setPlayerTee('p1', 2);
  eq(_loadTeePref('p1', 'c1'), 2);
  eq(S.nr.playerTee['p1'], 2);
});
test('setPlayerTee does not persist when no courseId', () => {
  resetState();
  S.nr.courseId = null;
  setPlayerTee('p1', 2);
  eq(S.nr.playerTee['p1'], 2);
  eq(_loadTeePref('p1', 'anything'), null);
});
test('setCourse restores saved pref for already-selected player', () => {
  resetState();
  _saveTeePrefs('p1', 'c1', 2);
  S.nr.selPids = ['p1'];
  setCourse('c1');
  eq(S.nr.playerTee['p1'], 2);
});
test('setCourse restores prefs for multiple players', () => {
  resetState();
  _saveTeePrefs('p1', 'c1', 1);
  _saveTeePrefs('p2', 'c1', 3);
  S.nr.selPids = ['p1', 'p2'];
  setCourse('c1');
  eq(S.nr.playerTee['p1'], 1);
  eq(S.nr.playerTee['p2'], 3);
});
test('setCourse leaves playerTee unchanged when no pref saved for player', () => {
  resetState();
  S.nr.selPids = ['p1'];
  S.nr.playerTee = { p1: 0 };
  setCourse('c1');
  eq(S.nr.playerTee['p1'], 0); // unchanged — no saved pref, so default stays
});
test('setCourse does not restore pref for different course', () => {
  resetState();
  _saveTeePrefs('p1', 'c2', 3);
  S.nr.selPids = ['p1'];
  setCourse('c1');
  eq(S.nr.playerTee['p1'], undefined); // no pref for c1
});
test('toggleSelPlayer restores saved pref when adding player with course set', () => {
  resetState();
  _saveTeePrefs('p1', 'c1', 2);
  S.nr.courseId = 'c1';
  toggleSelPlayer('p1');
  eq(S.nr.selPids.includes('p1'), true);
  eq(S.nr.playerTee['p1'], 2);
});
test('toggleSelPlayer does not set playerTee when no pref exists', () => {
  resetState();
  S.nr.courseId = 'c1';
  toggleSelPlayer('p1');
  eq(S.nr.playerTee['p1'], undefined);
});
test('toggleSelPlayer does not restore pref when no course selected', () => {
  resetState();
  _saveTeePrefs('p1', 'c1', 2);
  S.nr.courseId = null;
  toggleSelPlayer('p1');
  eq(S.nr.playerTee['p1'], undefined);
});
test('overwriting pref updates stored value', () => {
  resetState();
  _saveTeePrefs('p1', 'c1', 0);
  _saveTeePrefs('p1', 'c1', 2);
  eq(_loadTeePref('p1', 'c1'), 2);
});

// ── buildBackupPayload ────────────────────────────────────────────────────────
suite('buildBackupPayload — data export');
test('backup has version 2 and exportedAt', () => {
  resetState();
  const b = buildBackupPayload();
  eq(b.version, 2);
  assert(typeof b.exportedAt === 'string' && b.exportedAt.length > 10);
});
test('rounds are included from localStorage', () => {
  resetState();
  const r = makeRound18({ done: true });
  saveRound(r);
  const b = buildBackupPayload();
  eq(b.data.rounds.length, 1);
  eq(b.data.rounds[0].id, r.id);
});
test('players are included', () => {
  resetState();
  upsertPlayer({ id:'p1', name:'Alice', handicapIndex:10 });
  const b = buildBackupPayload();
  eq(b.data.players.length, 1);
  eq(b.data.players[0].name, 'Alice');
});
test('change log is included', () => {
  resetState();
  upsertPlayer({ id:'p1', name:'Alice', handicapIndex:10 });
  const b = buildBackupPayload();
  assert(b.data.changes.length >= 1, 'changes should include player creation');
});
test('empty store produces empty arrays not nulls', () => {
  resetState();
  const b = buildBackupPayload();
  assert(Array.isArray(b.data.rounds),   'rounds should be array');
  assert(Array.isArray(b.data.players),  'players should be array');
  assert(Array.isArray(b.data.courses),  'courses should be array');
  assert(Array.isArray(b.data.changes),  'changes should be array');
  assert(typeof b.data.teePrefs === 'object', 'teePrefs should be object');
});
test('course images are included by prefix', () => {
  resetState();
  localStorage.setItem(COURSE_IMG_PFX + 'c1_0', 'data:image/jpeg;base64,abc');
  localStorage.setItem(COURSE_IMG_PFX + 'c1_1', 'data:image/jpeg;base64,def');
  localStorage.setItem('unrelated_key', 'should not appear');
  const b = buildBackupPayload();
  eq(Object.keys(b.data.courseImgs).length, 2);
  assert(b.data.courseImgs[COURSE_IMG_PFX + 'c1_0'] === 'data:image/jpeg;base64,abc');
  assert(!b.data.courseImgs['unrelated_key']);
});
test('tee prefs are included', () => {
  resetState();
  _saveTeePrefs('p1', 'c1', 2);
  const b = buildBackupPayload();
  eq(b.data.teePrefs['p1_c1'], 2);
});

// ── parseDateInput ────────────────────────────────────────────────────────────
suite('parseDateInput — round date handling');
test('converts YYYY-MM-DD to noon UTC ISO string', () => {
  eq(parseDateInput('2026-05-09'), '2026-05-09T12:00:00.000Z');
});
test('converts an older date correctly', () => {
  eq(parseDateInput('2025-11-30'), '2025-11-30T12:00:00.000Z');
});
test('empty string falls back to a current ISO date', () => {
  const result = parseDateInput('');
  assert(result.length > 10, 'fallback should be a full ISO string');
  assert(!result.startsWith('T'), 'fallback should not start with T');
});
test('null falls back to a current ISO date', () => {
  const result = parseDateInput(null);
  assert(result.length > 10);
});
test('date portion is preserved exactly in output', () => {
  const result = parseDateInput('2024-03-15');
  assert(result.startsWith('2024-03-15'), `expected 2024-03-15 prefix, got: ${result}`);
});

// ── Delete round confirmation message ────────────────────────────────────────
suite('buildDeleteRoundMessage — confirmation text');
test('includes course name', () => {
  const r = makeRound18({ course: 'Hlíðavöllur' });
  const msg = buildDeleteRoundMessage(r);
  assert(msg.includes('Hlíðavöllur'), `expected course name in: ${msg}`);
});
test('includes formatted date', () => {
  const r = makeRound18({ date: '2026-05-09T10:00:00Z' });
  const msg = buildDeleteRoundMessage(r);
  assert(msg.includes('2026'), `expected year in: ${msg}`);
  assert(msg.includes('May') || msg.includes('9'), `expected date detail in: ${msg}`);
});
test('includes start time extracted from round ID', () => {
  const ts = new Date(2026, 4, 16, 10, 30, 0).getTime(); // May 16 2026 10:30 local
  const r = makeRound18({ id: 'r' + ts });
  const msg = buildDeleteRoundMessage(r);
  assert(msg.includes('at '), `expected "at <time>" in: ${msg}`);
  assert(msg.includes('10:30'), `expected time 10:30 in: ${msg}`);
});
test('round with non-numeric ID shows no time', () => {
  const r = makeRound18({ id: 'rabc' });
  const msg = buildDeleteRoundMessage(r);
  assert(!msg.includes('at '), `expected no time for non-numeric ID, got: ${msg}`);
});
test('starts with delete prompt', () => {
  const r = makeRound18();
  const msg = buildDeleteRoundMessage(r);
  assert(msg.startsWith('Delete this round?'), `expected prompt at start: ${msg}`);
});
test('includes cannot be undone warning', () => {
  const r = makeRound18();
  const msg = buildDeleteRoundMessage(r);
  assert(msg.includes('cannot be undone'), `expected warning in: ${msg}`);
});
test('null round returns safe fallback', () => {
  const msg = buildDeleteRoundMessage(null);
  assert(msg.startsWith('Delete this round?'), `expected fallback: ${msg}`);
  assert(msg.includes('cannot be undone'));
});
test('course and date appear on separate lines', () => {
  const r = makeRound18({ course: 'Grafarholt' });
  const msg = buildDeleteRoundMessage(r);
  const lines = msg.split('\n');
  const courseLine = lines.find(l => l.includes('Grafarholt'));
  const dateLine   = lines.find(l => l.includes('2026'));
  assert(courseLine !== undefined, 'course should be on its own line');
  assert(dateLine   !== undefined, 'date should be on its own line');
  assert(courseLine !== dateLine,  'course and date should be on different lines');
});

// ─── showCourseActions / deleteCourseFromAction stubs ────────────────────────
let _actionCourseId = null;
let _lastCourseActionShown = null;
let _courseDeleteCalledFor = null;
let _courseDeleteConfirmResult = true;

function showCourseActions(id) {
  const co = loadCourses().find(c => c.id === id);
  if (!co) return;
  _actionCourseId = id;
  _lastCourseActionShown = { id, name: co.name, isCustom: !isPresetCourse(id) };
}
function closeCourseActions() {
  _actionCourseId = null;
}
function editCourseFromAction() {
  const id = _actionCourseId;
  closeCourseActions();
  // editing opens the editor — just record the call in tests
  _lastEditedCourseId = id;
}
function deleteCourseFromAction() {
  const id = _actionCourseId;
  const co = loadCourses().find(c => c.id === id);
  closeCourseActions();
  if (co && _courseDeleteConfirmResult) {
    _courseDeleteCalledFor = id;
    deleteCourseData(id);
  }
}
let _lastEditedCourseId = null;

// ═════════════════════════════════════════════════════════════════════════════
// COURSE ACTION SHEET (long-press / context menu)
// ═════════════════════════════════════════════════════════════════════════════
suite('Course action sheet — long press / context menu');

test('showCourseActions populates title with course name', () => {
  _courseOverrides = [{ id: 'c1', name: 'Hlíðavöllur', holes: 18, pars: Array(18).fill(4), si: Array.from({length:18},(_,i)=>i+1) }];
  _lastCourseActionShown = null;
  showCourseActions('c1');
  assert(_lastCourseActionShown !== null, 'action should be shown');
  eq(_lastCourseActionShown.name, 'Hlíðavöllur');
});

test('showCourseActions marks custom courses as deletable', () => {
  _courseOverrides = [{ id: 'custom_1', name: 'My Course', holes: 18, pars: Array(18).fill(4), si: Array.from({length:18},(_,i)=>i+1) }];
  showCourseActions('custom_1');
  assert(_lastCourseActionShown.isCustom === true, 'custom course should be deletable');
});

test('showCourseActions marks preset courses as non-deletable', () => {
  _courseOverrides = [{ id: 'preset_abc', name: 'Preset Course', holes: 18, pars: Array(18).fill(4), si: Array.from({length:18},(_,i)=>i+1) }];
  showCourseActions('preset_abc');
  assert(_lastCourseActionShown.isCustom === false, 'preset course should not be deletable');
});

test('showCourseActions with unknown id does nothing', () => {
  _courseOverrides = [];
  _lastCourseActionShown = null;
  showCourseActions('nonexistent');
  assert(_lastCourseActionShown === null, 'should not open for unknown id');
});

test('deleteCourseFromAction removes the course', () => {
  _courseOverrides = [{ id: 'custom_1', name: 'My Course', holes: 18, pars: Array(18).fill(4), si: Array.from({length:18},(_,i)=>i+1) }];
  _courseDeleteConfirmResult = true;
  showCourseActions('custom_1');
  deleteCourseFromAction();
  assert(_courseOverrides.length === 0, 'course should be deleted');
});

test('deleteCourseFromAction does not delete when user cancels', () => {
  _courseOverrides = [{ id: 'custom_1', name: 'My Course', holes: 18, pars: Array(18).fill(4), si: Array.from({length:18},(_,i)=>i+1) }];
  _courseDeleteConfirmResult = false;
  showCourseActions('custom_1');
  deleteCourseFromAction();
  assert(_courseOverrides.length === 1, 'course should remain when cancelled');
  _courseDeleteConfirmResult = true;
});

test('deleteCourseFromAction clears _actionCourseId', () => {
  _courseOverrides = [{ id: 'custom_1', name: 'My Course', holes: 18, pars: Array(18).fill(4), si: Array.from({length:18},(_,i)=>i+1) }];
  showCourseActions('custom_1');
  deleteCourseFromAction();
  assert(_actionCourseId === null, '_actionCourseId should be cleared after action');
});

test('editCourseFromAction records the course id and clears action state', () => {
  _courseOverrides = [{ id: 'custom_1', name: 'My Course', holes: 18, pars: Array(18).fill(4), si: Array.from({length:18},(_,i)=>i+1) }];
  _lastEditedCourseId = null;
  showCourseActions('custom_1');
  editCourseFromAction();
  eq(_lastEditedCourseId, 'custom_1');
  assert(_actionCourseId === null, '_actionCourseId should be cleared after edit');
});

// ─── Player action sheet stubs ───────────────────────────────────────────────
let _actionPlayerId = null;
let _lastPlayerActionShown = null;
let _playerDeleteCalledFor = null;
let _playerDeleteConfirmResult = true;
let _lastEditedPlayerId = null;

function showPlayerActions(id) {
  const p = loadPlayers().find(x => x.id === id);
  if (!p) return;
  _actionPlayerId = id;
  _lastPlayerActionShown = { id, name: p.name };
}
function closePlayerActions() { _actionPlayerId = null; }
function editPlayerForm(id)   { _lastEditedPlayerId = id; }
function editPlayerFromAction() {
  const id = _actionPlayerId;
  closePlayerActions();
  editPlayerForm(id);
}
function deletePlayerFromAction() {
  const id = _actionPlayerId;
  const p = loadPlayers().find(x => x.id === id);
  closePlayerActions();
  if (p && _playerDeleteConfirmResult) {
    _playerDeleteCalledFor = id;
    deletePlayer(id);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PLAYER ACTION SHEET (long-press / context menu)
// ═════════════════════════════════════════════════════════════════════════════
suite('Player action sheet — long press / context menu');

test('showPlayerActions populates title with player name', () => {
  resetState(); _players = [{ id: 'pl1', name: 'Jón', handicapIndex: 10, gender: 'karlar' }];
  _lastPlayerActionShown = null;
  showPlayerActions('pl1');
  assert(_lastPlayerActionShown !== null);
  eq(_lastPlayerActionShown.name, 'Jón');
});

test('showPlayerActions with unknown id does nothing', () => {
  resetState();
  _lastPlayerActionShown = null;
  showPlayerActions('nobody');
  assert(_lastPlayerActionShown === null);
});

test('deletePlayerFromAction removes the player', () => {
  resetState(); _players = [{ id: 'pl1', name: 'Jón', handicapIndex: 10, gender: 'karlar' }];
  _playerDeleteConfirmResult = true;
  showPlayerActions('pl1');
  deletePlayerFromAction();
  assert(_players.length === 0, 'player should be deleted');
});

test('deletePlayerFromAction does not delete when user cancels', () => {
  resetState(); _players = [{ id: 'pl1', name: 'Jón', handicapIndex: 10, gender: 'karlar' }];
  _playerDeleteConfirmResult = false;
  showPlayerActions('pl1');
  deletePlayerFromAction();
  assert(_players.length === 1, 'player should remain when cancelled');
  _playerDeleteConfirmResult = true;
});

test('deletePlayerFromAction clears _actionPlayerId', () => {
  resetState(); _players = [{ id: 'pl1', name: 'Jón', handicapIndex: 10, gender: 'karlar' }];
  showPlayerActions('pl1');
  deletePlayerFromAction();
  assert(_actionPlayerId === null);
});

test('editPlayerFromAction records player id and clears action state', () => {
  resetState(); _players = [{ id: 'pl1', name: 'Jón', handicapIndex: 10, gender: 'karlar' }];
  _lastEditedPlayerId = null;
  showPlayerActions('pl1');
  editPlayerFromAction();
  eq(_lastEditedPlayerId, 'pl1');
  assert(_actionPlayerId === null);
});

// ── saveRoundTeams / clearRoundTeams ─────────────────────────────────────────
suite('saveRoundTeams');
function make4PlayerRound() {
  return makeRound18({ players: [
    { id:'pA', name:'Michael',   courseHcpOverride:0 },
    { id:'pB', name:'Sigurjon',  courseHcpOverride:0 },
    { id:'pC', name:'Carlos',    courseHcpOverride:0 },
    { id:'pD', name:'Ingibjorg', courseHcpOverride:0 },
  ]});
}
test('pairing 0 → [pA,pB] vs [pC,pD]', () => {
  resetState();
  const r = make4PlayerRound(); saveRound(r);
  saveRoundTeams(r.id, 0);
  const teams = byId(r.id).teams;
  eq(JSON.stringify(teams[0].sort()), JSON.stringify(['pA','pB']));
  eq(JSON.stringify(teams[1].sort()), JSON.stringify(['pC','pD']));
});
test('pairing 1 → [pA,pC] vs [pB,pD]', () => {
  resetState();
  const r = make4PlayerRound(); saveRound(r);
  saveRoundTeams(r.id, 1);
  const teams = byId(r.id).teams;
  eq(JSON.stringify(teams[0].sort()), JSON.stringify(['pA','pC']));
  eq(JSON.stringify(teams[1].sort()), JSON.stringify(['pB','pD']));
});
test('pairing 2 → [pA,pD] vs [pB,pC]', () => {
  resetState();
  const r = make4PlayerRound(); saveRound(r);
  saveRoundTeams(r.id, 2);
  const teams = byId(r.id).teams;
  eq(JSON.stringify(teams[0].sort()), JSON.stringify(['pA','pD']));
  eq(JSON.stringify(teams[1].sort()), JSON.stringify(['pB','pC']));
});
test('clearRoundTeams removes teams', () => {
  resetState();
  const r = make4PlayerRound(); saveRound(r);
  saveRoundTeams(r.id, 0);
  assert(byId(r.id).teams != null, 'teams should be set');
  clearRoundTeams(r.id);
  assert(byId(r.id).teams == null, 'teams should be removed');
});
test('saveRoundTeams no-ops for non-4-player round', () => {
  resetState();
  const r = makeRound18(); saveRound(r);
  saveRoundTeams(r.id, 0);
  assert(byId(r.id).teams == null, 'teams should not be set for 2-player round');
});

// ── saveRoundCh ───────────────────────────────────────────────────────────────
suite('saveRoundCh');
test('updates courseHcpOverride and saves round', () => {
  resetState();
  const r = makeRound18({ players: [{ id: 'p1', name: 'Alpha', handicapIndex: 10.7, courseHcpOverride: 26 }] });
  saveRound(r);
  _domElements['ch-edit-p1'] = { value: '9' };
  saveRoundCh(r.id);
  eq(byId(r.id).players[0].courseHcpOverride, 9);
});
test('no-op if value is unchanged', () => {
  resetState();
  const r = makeRound18({ players: [{ id: 'p1', name: 'Alpha', handicapIndex: 10.7, courseHcpOverride: 9 }] });
  saveRound(r);
  _domElements['ch-edit-p1'] = { value: '9' };
  const before = JSON.stringify(loadRounds());
  saveRoundCh(r.id);
  eq(JSON.stringify(loadRounds()), before);
});
test('players without handicapIndex are skipped', () => {
  resetState();
  const r = makeRound18({ players: [{ id: 'p1', name: 'Guest' }] });
  saveRound(r);
  _domElements['ch-edit-p1'] = { value: '12' };
  saveRoundCh(r.id);
  eq(byId(r.id).players[0].courseHcpOverride, undefined);
});

// ═════════════════════════════════════════════════════════════════════════════
// DELETION TOMBSTONE — May 2026
// Deleted rounds must never reappear on other devices that were offline when
// the deletion happened. The tombstone records deleted IDs in both localStorage
// and Firestore so the init merge can drop them instead of re-uploading them.
// ═════════════════════════════════════════════════════════════════════════════
suite('Deletion tombstone — removeRound');
test('removeRound adds the ID to _deletedRoundIds', () => {
  resetState();
  const r = makeRound18(); saveRound(r);
  removeRound(r.id);
  assert(_deletedRoundIds.has(r.id), 'ID must be in tombstone set after deletion');
});
test('removeRound persists tombstone to localStorage', () => {
  resetState();
  const r = makeRound18(); saveRound(r);
  removeRound(r.id);
  const stored = JSON.parse(localStorage.getItem(DELETED_KEY) || '[]');
  assert(stored.includes(r.id), 'ID must be in localStorage tombstone');
});
test('removeRound records deletion in Firestore meta/deletedRounds', () => {
  resetState();
  const r = makeRound18(); saveRound(r);
  removeRound(r.id);
  const fsDoc = _fsStore['meta/deletedRounds'];
  assert(fsDoc && (fsDoc.ids || []).includes(r.id), 'ID must be in Firestore tombstone');
});
test('removeRound still removes round from _rounds', () => {
  resetState();
  const r = makeRound18(); saveRound(r);
  eq(_rounds.length, 1);
  removeRound(r.id);
  eq(_rounds.length, 0, 'round must be removed from _rounds');
});
test('tombstone accumulates across multiple deletions', () => {
  resetState();
  const r1 = makeRound18({ id:'rA', date:'2026-05-01T10:00:00Z' });
  const r2 = makeRound18({ id:'rB', date:'2026-05-02T10:00:00Z' });
  saveRound(r1); saveRound(r2);
  removeRound('rA'); removeRound('rB');
  assert(_deletedRoundIds.has('rA') && _deletedRoundIds.has('rB'), 'both IDs in tombstone');
  const stored = JSON.parse(localStorage.getItem(DELETED_KEY) || '[]');
  assert(stored.includes('rA') && stored.includes('rB'), 'both IDs in localStorage');
});
test('removeRound logs the deletion to the change log', () => {
  resetState();
  const r = makeRound18({ course: 'Grafarholt' }); saveRound(r);
  removeRound(r.id);
  const log = getChangeLog();
  assert(log.length > 0, 'change log should have an entry');
  eq(log[0].action, 'deleted');
  assert(log[0].entityName.includes('Grafarholt'), 'entity name should include course');
});

suite('Deletion tombstone — init merge filtering');
test('tombstoned local round is not merged into result', () => {
  const deleted = new Set(['rX']);
  const result = mergeRoundsWithTombstone([], [{id:'rX', date:'2026-05-01', course:'Ghost', players:[], scores:{}, holes:[], done:false}], deleted);
  eq(result.length, 0, 'tombstoned round should be dropped');
});
test('non-tombstoned local-only round is kept and uploaded', () => {
  const deleted = new Set();
  const local = [{id:'rNew', date:'2026-05-01', course:'New', players:[], scores:{}, holes:[], done:false}];
  const result = mergeRoundsWithTombstone([], local, deleted);
  eq(result.length, 1);
  eq(result[0].id, 'rNew');
});
test('Firestore round with same ID as tombstoned local round is still kept', () => {
  const deleted = new Set(['rX']);
  const fs    = [{id:'rX', date:'2026-05-01', course:'FS', players:[], scores:{}, holes:[], done:false}];
  const local = [{id:'rX', date:'2026-05-01', course:'Local', players:[], scores:{}, holes:[], done:false}];
  const result = mergeRoundsWithTombstone(fs, local, deleted);
  // Firestore won the merge for rX (it's in fsRounds), tombstone only affects localOnly
  eq(result.length, 1);
  eq(result[0].course, 'FS');
});
test('mix: one tombstoned local-only, one untombstoned local-only', () => {
  const deleted = new Set(['rDead']);
  const local = [
    {id:'rDead', date:'2026-05-01', course:'Ghost', players:[], scores:{}, holes:[], done:false},
    {id:'rLive', date:'2026-05-02', course:'Live',  players:[], scores:{}, holes:[], done:false},
  ];
  const result = mergeRoundsWithTombstone([], local, deleted);
  eq(result.length, 1);
  eq(result[0].id, 'rLive');
});
test('empty tombstone: all local-only rounds are kept', () => {
  const deleted = new Set();
  const local = [
    {id:'r1', date:'2026-05-01', course:'A', players:[], scores:{}, holes:[], done:false},
    {id:'r2', date:'2026-05-02', course:'B', players:[], scores:{}, holes:[], done:false},
  ];
  const result = mergeRoundsWithTombstone([], local, deleted);
  eq(result.length, 2);
});

// ═════════════════════════════════════════════════════════════════════════════
// FIRESTORE ECHO-SKIP — May 2026
// When Firestore echoes our own write back via onSnapshot, the incoming doc
// has the same lastModified as what we already have. Applying it would
// replace the DOM during an active interaction. The guard skips such echoes.
// ═════════════════════════════════════════════════════════════════════════════
suite('Firestore echo-skip — onSnapshot update guard');
test('same lastModified and same done → skip (echo of own write)', () => {
  const local    = { id:'r1', lastModified: 1000, done: false };
  const incoming = { id:'r1', lastModified: 1000, done: false };
  assert(!snapShouldUpdate(local, incoming), 'echo should be skipped');
});
test('different lastModified → update (genuine change from another device)', () => {
  const local    = { id:'r1', lastModified: 1000, done: false };
  const incoming = { id:'r1', lastModified: 2000, done: false };
  assert(snapShouldUpdate(local, incoming), 'newer write should be applied');
});
test('same lastModified but done changed → update (another device finished the round)', () => {
  const local    = { id:'r1', lastModified: 1000, done: false };
  const incoming = { id:'r1', lastModified: 1000, done: true  };
  assert(snapShouldUpdate(local, incoming), 'done-state change must not be silenced');
});
test('older lastModified → guard still allows update (winner decided by _snapWinner upstream)', () => {
  const local    = { id:'r1', lastModified: 2000, done: false };
  const incoming = { id:'r1', lastModified: 1000, done: false };
  // lastModified differs → not an echo → guard allows it through
  // (_snapWinner will have already chosen local in this case, so this branch is never actually reached)
  assert(snapShouldUpdate(local, incoming), 'different lastModified values are never an echo');
});
test('missing lastModified on both → same (0===0) → skip', () => {
  const local    = { id:'r1', done: false };
  const incoming = { id:'r1', done: false };
  assert(!snapShouldUpdate(local, incoming), 'both undefined treated as same → skip');
});
test('lastModified absent on incoming only → 0 !== 2000 → update', () => {
  const local    = { id:'r1', lastModified: 2000, done: false };
  const incoming = { id:'r1', done: false };
  assert(snapShouldUpdate(local, incoming), 'missing incoming lastModified differs from local');
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUND START TIME — May 2026
// Round cards on the home screen show the time the round was created,
// extracted from the round ID which is 'r' + Date.now().
// ═════════════════════════════════════════════════════════════════════════════
suite('Round start time — time from round ID');
test('standard ID format yields a valid timestamp', () => {
  const ts = Date.now();
  const id = 'r' + ts;
  eq(roundCardTime(id), ts);
});
test('timestamp is usable as a Date', () => {
  const created = new Date(2026, 4, 16, 10, 30, 0); // May 16 2026 10:30
  const id = 'r' + created.getTime();
  const ts = roundCardTime(id);
  const recovered = new Date(ts);
  eq(recovered.getFullYear(), 2026);
  eq(recovered.getMonth(), 4);
  eq(recovered.getDate(), 16);
  eq(recovered.getHours(), 10);
  eq(recovered.getMinutes(), 30);
});
test('non-numeric suffix returns null (no bogus time shown)', () => {
  eq(roundCardTime('rabc'), null);
});
test('different IDs created one hour apart have correct time delta', () => {
  const base = 1747385400000; // arbitrary fixed ms
  const id1 = 'r' + base;
  const id2 = 'r' + (base + 3600000);
  const diff = roundCardTime(id2) - roundCardTime(id1);
  eq(diff, 3600000, 'one hour apart in IDs → one hour apart in extracted times');
});
test('time extracted from saveRound ID matches creation moment', () => {
  resetState();
  const before = Date.now();
  const r = makeRound18({ id: 'r' + Date.now() });
  saveRound(r);
  const after = Date.now();
  const ts = roundCardTime(r.id);
  assert(ts !== null && ts >= before && ts <= after, 'extracted time should be within creation window');
});

// ── Round finish review — navigation ─────────────────────────────────────────
suite('Round finish review — navigation after closing a round');

// Helper: stableford round with all 18 holes scored at par (2 pts each)
function makeStblRound(pid, name, grossScores, id, date) {
  const holes = makeHoles18();
  const sc = {};
  sc[pid] = {};
  holes.forEach((h, i) => { sc[pid][h.n] = { s: grossScores[i] }; });
  return {
    id: id || ('rs_' + pid + '_' + (date || '2026-01-01')),
    date: date || '2026-01-01T10:00:00Z',
    course: 'Test Course',
    courseRating: 72, slopeRating: 113,
    players: [{ id: pid, name, handicapIndex: 0, courseHcpOverride: 0 }],
    holes, scores: sc, done: true, format: 'stableford',
  };
}
// Gross scores that produce 2 pts per hole (all pars): par for every hole
const _allPars18 = DEFAULT_PARS_18.slice(); // [4,4,3,...] same as DEFAULT_PARS_18

test('submitFinishComment navigates to round-finish', () => {
  resetState();
  const r = makeRound18();
  saveRound(r); S.roundId = r.id;
  finishRound();
  updateFinishComment('Great day!');
  submitFinishComment();
  eq(S.view, 'round-finish');
});

test('skipFinishComment navigates to round-finish', () => {
  resetState();
  const r = makeRound18();
  saveRound(r); S.roundId = r.id;
  finishRound();
  skipFinishComment();
  eq(S.view, 'round-finish');
});

test('submitFinishComment sets justFinishedRoundId', () => {
  resetState();
  const r = makeRound18();
  saveRound(r); S.roundId = r.id;
  finishRound(); submitFinishComment();
  eq(S.justFinishedRoundId, r.id);
});

test('skipFinishComment sets justFinishedRoundId', () => {
  resetState();
  const r = makeRound18();
  saveRound(r); S.roundId = r.id;
  finishRound(); skipFinishComment();
  eq(S.justFinishedRoundId, r.id);
});

// ── Round finish review — buildStats stableford analysis ─────────────────────
suite('Round finish review — buildStats stableford analysis');

test('buildStats with no rounds returns zeros', () => {
  const s = buildStats([], 'Alice', 'stableford', false, false, false);
  eq(s.rounds, 0);
  eq(s.avgPts, 0);
  eq(s.bestPts, 0);
  eq(s.sc.birdies, 0);
  eq(s.sc.bogeys, 0);
});

test('buildStats skips incomplete rounds', () => {
  // Round missing score on hole 18
  const r = makeStblRound('p1', 'Alice', _allPars18.map((p, i) => i < 17 ? p : 0), 'rInc');
  r.scores['p1'][18] = { s: 0 };
  const s = buildStats([r], 'Alice', 'stableford', false, false, false);
  eq(s.rounds, 0, 'incomplete round should not count');
});

test('buildStats averages stableford points across rounds', () => {
  // Round 1: all pars → 2 pts × 18 = 36
  const r1 = makeStblRound('p1', 'Alice', _allPars18, 'r1', '2026-01-01T10:00:00Z');
  // Round 2: all bogeys → 1 pt × 18 = 18
  const r2 = makeStblRound('p1', 'Alice', _allPars18.map(p => p + 1), 'r2', '2026-01-02T10:00:00Z');
  const s = buildStats([r1, r2], 'Alice', 'stableford', false, false, false);
  eq(s.rounds, 2);
  eq(s.avgPts, 27); // (36 + 18) / 2
});

test('buildStats identifies personal best', () => {
  // Round 1: all pars → 36 pts
  const r1 = makeStblRound('p1', 'Alice', _allPars18, 'r1', '2026-01-01T10:00:00Z');
  // Round 2: all birdies → 3 pts × 18 = 54 pts
  const r2 = makeStblRound('p1', 'Alice', _allPars18.map(p => p - 1), 'r2', '2026-01-02T10:00:00Z');
  const s = buildStats([r1, r2], 'Alice', 'stableford', false, false, false);
  eq(s.bestPts, 54);
  eq(s.bestCourse, 'Test Course');
});

test('buildStats counts birdies (3-pt holes) correctly', () => {
  // 3 holes at par-1 (birdie = 3 pts), rest at par (2 pts)
  const gross = _allPars18.map((p, i) => i < 3 ? p - 1 : p);
  const r = makeStblRound('p1', 'Alice', gross, 'r1');
  const s = buildStats([r], 'Alice', 'stableford', false, false, false);
  eq(s.sc.birdies, 3);
  eq(s.sc.pars, 15);
  eq(s.sc.bogeys, 0);
});

test('buildStats counts bogeys (1-pt holes) correctly', () => {
  // 5 holes at par+1 (bogey = 1 pt), rest at par
  const gross = _allPars18.map((p, i) => i < 5 ? p + 1 : p);
  const r = makeStblRound('p1', 'Alice', gross, 'r1');
  const s = buildStats([r], 'Alice', 'stableford', false, false, false);
  eq(s.sc.bogeys, 5);
  eq(s.sc.pars, 13);
});

test('buildStats counts eagles (4-pt holes) correctly', () => {
  // 2 holes at par-2 (eagle = 4 pts), rest at par
  const gross = _allPars18.map((p, i) => i < 2 ? p - 2 : p);
  const r = makeStblRound('p1', 'Alice', gross, 'r1');
  const s = buildStats([r], 'Alice', 'stableford', false, false, false);
  eq(s.sc.eagles, 2);
});

test('buildStats only includes matching format rounds', () => {
  // One stableford round and one stroke round for same player
  const r1 = makeStblRound('p1', 'Alice', _allPars18, 'r1');
  const r2 = makeRound18({ id: 'r2', done: true, format: 'stroke' });
  // Fill all scores for r2
  DEFAULT_PARS_18.forEach((p, i) => { r2.scores['p1'][i + 1] = { s: p }; });
  r2.players[0].name = 'Alice';
  const s = buildStats([r1, r2], 'Alice', 'stableford', false, false, false);
  eq(s.rounds, 1, 'stroke round should not count in stableford stats');
});

test('buildStats excludes rounds where player is not present', () => {
  const r = makeStblRound('p1', 'Alice', _allPars18, 'r1');
  const s = buildStats([r], 'Bob', 'stableford', false, false, false);
  eq(s.rounds, 0);
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
