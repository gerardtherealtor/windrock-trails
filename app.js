(function(){
'use strict';
// ---------- config ----------
const AREAS = [
  // Starting views. Trail lines come from OpenStreetMap for whatever is on screen, so these just get you to the right mountain.
  {id:'windrock', name:'Windrock Park (Oliver Springs)', lat:36.115, lon:-84.365, z:13, bbox:[36.03,-84.46,36.22,-84.27]},
  {id:'brimstone', name:'Brimstone Recreation (Huntsville)', lat:36.405, lon:-84.505, z:13, bbox:[36.33,-84.61,36.48,-84.41]},
  {id:'royalblue', name:'Royal Blue / North Cumberland WMA', lat:36.330, lon:-84.330, z:12, bbox:[36.22,-84.46,36.46,-84.19]},
  {id:'coalcreek', name:'Coal Creek OHV (Briceville)', lat:36.195, lon:-84.325, z:13, bbox:[36.14,-84.41,36.26,-84.24]},
  {id:'huntsville', name:'Huntsville, TN', lat:36.416, lon:-84.493, z:13, bbox:[36.36,-84.56,36.47,-84.43]},
];
const LAYERS = {
  sat:  {name:'Satellite', sub:'Esri World Imagery', url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr:'Esri, Maxar, Earthstar Geographics', maxZoom:19},
  usgs: {name:'USGS Topo', sub:'Official 7.5-minute topo', url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', attr:'USGS The National Map', maxZoom:16},
  hyb:  {name:'Imagery + Topo', sub:'USGS imagery with contours', url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}', attr:'USGS The National Map', maxZoom:16},
  otm:  {name:'OpenTopoMap', sub:'Shaded relief + trails', url:'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attr:'© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)', maxZoom:17, sub_:['a','b','c']},
  osm:  {name:'Street', sub:'OpenStreetMap', url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr:'© OpenStreetMap contributors', maxZoom:19},
};
const OVERPASS = ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.private.coffee/api/interpreter'];
const TRAIL_MIN_ZOOM = 12;
const M2FT = 3.28084, M2MI = 1/1609.344;

// ---------- tiny IndexedDB ----------
const DB = (()=>{
  let dbp;
  function open(){
    if(dbp) return dbp;
    dbp = new Promise((res,rej)=>{
      const r = indexedDB.open('windrock-trails', 2);
      r.onupgradeneeded = e=>{
        const d = e.target.result;
        ['rides','waypoints','packs'].forEach(n=>{ if(!d.objectStoreNames.contains(n)) d.createObjectStore(n,{keyPath:'id'}); });
        if(!d.objectStoreNames.contains('trails')) d.createObjectStore('trails',{keyPath:'key'});
        if(!d.objectStoreNames.contains('kv')) d.createObjectStore('kv',{keyPath:'k'});
      };
      r.onsuccess = ()=>res(r.result); r.onerror = ()=>rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn){
    const d = await open();
    return new Promise((res,rej)=>{
      const t = d.transaction(store, mode); const s = t.store ? t.store : t.objectStore(store);
      const out = fn(s);
      t.oncomplete = ()=>res(out && out.result !== undefined ? out.result : out);
      t.onerror = ()=>rej(t.error);
    });
  }
  return {
    get:(s,k)=>tx(s,'readonly',st=>st.get(k)),
    all:(s)=>tx(s,'readonly',st=>st.getAll()),
    put:(s,v)=>tx(s,'readwrite',st=>st.put(v)),
    del:(s,k)=>tx(s,'readwrite',st=>st.delete(k)),
  };
})();

// ---------- helpers ----------
const $ = id=>document.getElementById(id);
const fmt1 = n=>(Math.round(n*10)/10).toFixed(1);
let toastT;
function toast(msg, ms=2200){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'), ms); }
let statusT;
function status(msg, sticky){ const s=$('status'); if(!msg){ s.classList.add('off'); return; } s.textContent=msg; s.classList.remove('off'); clearTimeout(statusT); if(!sticky) statusT=setTimeout(()=>s.classList.add('off'), 3000); }
function havKm(a,b){ const R=6371, dLat=(b[0]-a[0])*Math.PI/180, dLon=(b[1]-a[1])*Math.PI/180, la1=a[0]*Math.PI/180, la2=b[0]*Math.PI/180; const h=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function compass(d){ const n=['N','NE','E','SE','S','SW','W','NW']; return n[Math.round(d/45)%8]; }
function fmtDur(ms){ const s=Math.floor(ms/1000); const h=Math.floor(s/3600), m=Math.floor(s%3600/60); return h? `${h}h ${m}m` : `${m}m`; }
function fmtDate(t){ return new Date(t).toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}); }

// ---------- map ----------
const map = L.map('map', {zoomControl:false, attributionControl:true, tap:false, preferCanvas:true});
L.control.scale({imperial:true, metric:false, position:'bottomleft'}).addTo(map);
let baseKey = 'sat'; try{ baseKey = localStorage.getItem('wt.base') || 'sat'; }catch(e){}
if(!LAYERS[baseKey]) baseKey='sat';
let baseLayer = null;
function setBase(k){
  if(baseLayer) map.removeLayer(baseLayer);
  const c = LAYERS[k]; baseKey = k;
  baseLayer = L.tileLayer(c.url, {attribution:c.attr, maxNativeZoom:c.maxZoom, maxZoom:19, subdomains:c.sub_||'abc', crossOrigin:true}).addTo(map);
  try{ localStorage.setItem('wt.base', k); }catch(e){}
}
setBase(baseKey);

const trailLayer = L.layerGroup().addTo(map);
const packLayer = L.layerGroup().addTo(map); // imported trail maps (GPX packs)
const rideLayer = L.layerGroup().addTo(map);
const wpLayer = L.layerGroup().addTo(map);
const liveLayer = L.layerGroup().addTo(map);

// start view
let startArea = 'windrock'; try{ startArea = localStorage.getItem('wt.area') || 'windrock'; }catch(e){}
let savedView = null; try{ savedView = JSON.parse(localStorage.getItem('wt.view')||'null'); }catch(e){}
const sel = $('areaSel');
AREAS.forEach(a=>{ const o=document.createElement('option'); o.value=a.id; o.textContent=a.name; sel.appendChild(o); });
sel.value = startArea;
function goArea(id){ const a=AREAS.find(x=>x.id===id); if(!a) return; map.setView([a.lat,a.lon], a.z); try{ localStorage.setItem('wt.area', id); }catch(e){} }
sel.addEventListener('change', ()=>goArea(sel.value));
if(savedView && savedView.lat) map.setView([savedView.lat, savedView.lon], savedView.z); else goArea(startArea);
map.on('moveend', ()=>{ const c=map.getCenter(); try{ localStorage.setItem('wt.view', JSON.stringify({lat:c.lat, lon:c.lng, z:map.getZoom()})); }catch(e){} });

// ---------- trails from OpenStreetMap ----------
const trailCache = new Map(); // key -> {ways, t}
let trailsOn = true; try{ trailsOn = localStorage.getItem('wt.trails') !== '0'; }catch(e){}
let loadingTrails = false, pendingTrails = false;
const trailFeatures = new Map(); // osm id -> layer

function trailStyle(t){
  const hw = t.highway;
  if(hw==='track') return {color:'#ff8a1f', weight:3, opacity:.95};
  if(hw==='path' || hw==='bridleway') return {color:'#ffe066', weight:2.5, opacity:.95, dashArray:'6 5'};
  if(hw==='unclassified' || hw==='service') return {color:'#cfd8d0', weight:2, opacity:.8};
  return {color:'#9fb0a2', weight:2, opacity:.6};
}
function trailPopup(t, id){
  const name = t.name || t.ref || (t.highway==='track' ? 'Unnamed track' : t.highway==='path' ? 'Unnamed path' : 'Unnamed road');
  const tags = [];
  if(t.ref && t.name) tags.push('#'+t.ref);
  if(t.tracktype) tags.push(t.tracktype.replace('grade','grade '));
  if(t.surface) tags.push(t.surface);
  if(t.sac_scale) tags.push(t.sac_scale);
  ['atv','motor_vehicle','motorcycle','access','vehicle'].forEach(k=>{ if(t[k]) tags.push(k.replace('_',' ')+': '+t[k]); });
  if(t.width) tags.push('width '+t.width);
  if(t.difficulty) tags.push('difficulty '+t.difficulty);
  if(t.description) tags.push(t.description);
  return `<b>${esc(name)}</b><br><span class="tag">${esc(t.highway)}</span>${tags.map(x=>`<span class="tag">${esc(x)}</span>`).join('')}<br><button class="pbtn" data-act="wp-here">Mark here</button>`;
}
function bboxKey(b){ return [b.getSouth(),b.getWest(),b.getNorth(),b.getEast()].map(x=>x.toFixed(3)).join(',');}
function gridCells(b){
  // 0.1° cells so a cache hit covers repeated visits to the same mountain
  const cells=[]; const s=Math.floor(b.getSouth()*10)/10, n=Math.ceil(b.getNorth()*10)/10, w=Math.floor(b.getWest()*10)/10, e=Math.ceil(b.getEast()*10)/10;
  for(let la=s; la<n-1e-9; la=+(la+0.1).toFixed(1)) for(let lo=w; lo<e-1e-9; lo=+(lo+0.1).toFixed(1)) cells.push({s:la, w:lo, n:+(la+0.1).toFixed(1), e:+(lo+0.1).toFixed(1), key:`${la.toFixed(1)},${lo.toFixed(1)}`});
  return cells;
}
const HW_FILTER = '["highway"~"^(track|path|bridleway|unclassified|service)$"]';
let opQueue = Promise.resolve();
function queued(fn){ const p = opQueue.then(fn, fn); opQueue = p.catch(()=>{}); return p; }
async function overpass(q){
  let lastErr;
  for(const ep of OVERPASS){
    for(let attempt=0; attempt<2; attempt++){
      try{
        const r = await fetch(ep, {method:'POST', body:'data='+encodeURIComponent(q), headers:{'Content-Type':'application/x-www-form-urlencoded'}});
        if(r.status===429 || r.status===504 || r.status===503){ lastErr=new Error('HTTP '+r.status); await new Promise(res=>setTimeout(res, 2000*(attempt+1))); continue; }
        if(!r.ok) throw new Error('HTTP '+r.status);
        return await r.json();
      }catch(e){ lastErr=e; break; }
    }
  }
  throw lastErr || new Error('trail fetch failed');
}
// One request for a batch of cells; results are stored per cell so repeat visits and offline use are instant.
async function fetchCells(cells){
  if(!cells.length) return [];
  const q = `[out:json][timeout:90];(${cells.map(c=>`way${HW_FILTER}(${c.s},${c.w},${c.n},${c.e});`).join('')});out tags geom;`;
  const j = await overpass(q);
  const ways = (j.elements||[]).filter(e=>e.type==='way' && e.geometry && e.geometry.length>1).map(e=>({id:e.id, tags:e.tags||{}, pts:e.geometry.map(p=>[p.lat,p.lon])}));
  const byCell = new Map(cells.map(c=>[c.key, []]));
  ways.forEach(w=>{
    let s=90,n=-90,wl=180,e=-180; w.pts.forEach(p=>{ if(p[0]<s)s=p[0]; if(p[0]>n)n=p[0]; if(p[1]<wl)wl=p[1]; if(p[1]>e)e=p[1]; });
    cells.forEach(c=>{ if(!(n<c.s||s>c.n||e<c.w||wl>c.e)) byCell.get(c.key).push(w); });
  });
  for(const c of cells){ const rec={key:c.key, ways:byCell.get(c.key), t:Date.now()}; trailCache.set(c.key, rec); try{ await DB.put('trails', rec); }catch(e){} }
  return ways;
}
async function cachedCell(c){
  let rec = trailCache.get(c.key); if(rec) return rec;
  try{ const d = await DB.get('trails', c.key); if(d && Date.now()-d.t < 90*864e5){ trailCache.set(c.key, d); return d; } }catch(e){}
  return null;
}
function addWays(ways){
  let n=0;
  ways.forEach(w=>{
    if(trailFeatures.has(w.id)) return;
    const pl = L.polyline(w.pts, trailStyle(w.tags));
    pl.bindPopup(()=>trailPopup(w.tags, w.id));
    pl._wt = w; trailLayer.addLayer(pl); trailFeatures.set(w.id, pl); n++;
  });
  return n;
}
function pruneFar(){ const big = map.getBounds().pad(1.5); trailFeatures.forEach((pl,id)=>{ if(!big.intersects(pl.getBounds())){ trailLayer.removeLayer(pl); trailFeatures.delete(id); } }); }
let loadToken = 0, trailRetries = 0;
async function loadTrails(){
  if(!trailsOn){ trailLayer.clearLayers(); trailFeatures.clear(); return; }
  if(map.getZoom() < TRAIL_MIN_ZOOM){ trailLayer.clearLayers(); trailFeatures.clear(); status('Zoom in to load trails'); return; }
  const token = ++loadToken;
  const cells = gridCells(map.getBounds().pad(0.05));
  if(cells.length > 60){ status('Zoom in to load trails'); return; }
  const missing = [];
  for(const c of cells){ const rec = await cachedCell(c); if(rec) addWays(rec.ways); else missing.push(c); }
  pruneFar();
  if(!missing.length){ status(''); trailRetries=0; return; }
  if(!navigator.onLine){ status('Offline: trails not saved for part of this view'); return; }
  status('Loading trails from OpenStreetMap…', true);
  try{
    const ways = await queued(()=>fetchCells(missing));
    addWays(ways); trailRetries = 0;
    if(token===loadToken) status('');
  }catch(e){
    if(trailRetries < 3){ trailRetries++; status('Trail server busy, retrying…', true); setTimeout(()=>{ if(token===loadToken) loadTrails(); }, 5000); }
    else status('Trail server not responding. Try again in a minute.');
  }
}
let trailDeb;
map.on('moveend zoomend', ()=>{ clearTimeout(trailDeb); trailDeb=setTimeout(loadTrails, 600); });
map.whenReady(()=>setTimeout(loadTrails, 300));
map.on('popupopen', e=>{
  const btn = e.popup.getElement().querySelector('[data-act="wp-here"]');
  if(btn) btn.addEventListener('click', ()=>{ map.closePopup(); openWaypointEditor(e.popup.getLatLng()); });
  const del = e.popup.getElement().querySelector('[data-act="wp-del"]');
  if(del) del.addEventListener('click', async ()=>{ await DB.del('waypoints', del.dataset.id); map.closePopup(); renderWaypoints(); toast('Waypoint deleted'); });
});

// ---------- GPS ----------
let watchId = null, following = false, lastFix = null, headingDeg = null, wakeLock = null;
const gpsIcon = L.divIcon({className:'gpsdot', html:'<div class="arrow"><svg viewBox="0 0 28 28"><circle cx="14" cy="14" r="13" fill="rgba(242,140,40,.25)"/><path d="M14 3 L22 22 L14 17 L6 22 Z" fill="#f28c28" stroke="#1a1006" stroke-width="1.5" stroke-linejoin="round"/></svg></div>', iconSize:[0,0]});
let gpsMarker = null, accCircle = null;
function setFollow(on){ following = on; $('bLocate').classList.toggle('on', on); if(on && lastFix) map.setView([lastFix.lat,lastFix.lon], Math.max(map.getZoom(), 15)); }
map.on('dragstart', ()=>{ if(following) setFollow(false); });
function onFix(pos){
  const c = pos.coords; lastFix = {lat:c.latitude, lon:c.longitude, acc:c.accuracy, alt:c.altitude, spd:c.speed, t:pos.timestamp};
  if(c.heading !== null && !isNaN(c.heading) && c.speed > 0.8) headingDeg = c.heading;
  const ll = [c.latitude, c.longitude];
  if(!gpsMarker){ gpsMarker = L.marker(ll, {icon:gpsIcon, interactive:false, zIndexOffset:1000}).addTo(liveLayer); accCircle = L.circle(ll, {radius:c.accuracy||0, color:'#f28c28', weight:1, opacity:.5, fillOpacity:.08, interactive:false}).addTo(liveLayer); }
  else { gpsMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(c.accuracy||0); }
  const arrow = gpsMarker.getElement() && gpsMarker.getElement().querySelector('.arrow'); if(arrow) arrow.style.transform = `rotate(${headingDeg||0}deg)`;
  if(following) map.panTo(ll, {animate:true, duration:.4});
  $('hSpeed').textContent = c.speed!=null && c.speed>=0 ? Math.round(c.speed*2.23694) : '--';
  $('hElev').textContent = c.altitude!=null ? Math.round(c.altitude*M2FT).toLocaleString() : '--';
  $('hHead').textContent = headingDeg!=null ? `${Math.round(headingDeg)}° ${compass(headingDeg)}` : '--';
  $('hAcc').textContent = c.accuracy!=null ? Math.round(c.accuracy*M2FT) : '--';
  if(rec) recPoint(lastFix);
}
function onGpsErr(e){ status(e.code===1 ? 'Location permission denied. Allow it in your browser settings.' : 'Waiting for GPS…'); }
function startGps(){
  if(!('geolocation' in navigator)){ toast('No GPS on this device/browser'); return; }
  if(watchId!==null) return;
  watchId = navigator.geolocation.watchPosition(onFix, onGpsErr, {enableHighAccuracy:true, maximumAge:1000, timeout:20000});
  status('Acquiring GPS…');
}
async function keepAwake(on){
  try{ if(on && 'wakeLock' in navigator && !wakeLock){ wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', ()=>{ wakeLock=null; }); } else if(!on && wakeLock){ await wakeLock.release(); wakeLock=null; } }catch(e){}
}
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible' && (rec||following)) keepAwake(true); });
$('bLocate').addEventListener('click', ()=>{ startGps(); setFollow(!following); keepAwake(following||!!rec); if(following && lastFix) map.setView([lastFix.lat,lastFix.lon], Math.max(map.getZoom(),15)); });

// ---------- recording ----------
let rec = null, recLine = null;
function recPoint(f){
  if(f.acc && f.acc > 60) return; // skip junk fixes
  const p = [f.lat, f.lon, f.alt, f.t];
  const last = rec.pts[rec.pts.length-1];
  if(last){ const d = havKm([last[0],last[1]],[f.lat,f.lon]); if(d < 0.003) return; rec.dist += d; }
  rec.pts.push(p);
  if(!recLine){ recLine = L.polyline([], {color:'#ff5c5c', weight:4, opacity:.9}).addTo(rideLayer); }
  recLine.addLatLng([f.lat,f.lon]);
  $('hDist').textContent = fmt1(rec.dist*1000*M2MI);
  if(rec.pts.length % 10 === 0) persistRec();
}
async function persistRec(){ if(!rec) return; try{ await DB.put('rides', {...rec, pts:rec.pts}); }catch(e){} }
async function startRec(){
  startGps(); keepAwake(true);
  rec = {id:uid(), name:'Ride '+new Date().toLocaleDateString([], {month:'short', day:'numeric'}), start:Date.now(), end:null, dist:0, pts:[], area:sel.options[sel.selectedIndex].text};
  recLine = null; $('bRec').classList.add('recing'); $('bRec').querySelector('span').textContent='stop'; $('hRecBox').classList.add('rec'); $('hDistL').textContent='mi ride'; $('hDist').textContent='0.0';
  if(!following) setFollow(true);
  toast('Recording ride');
}
async function stopRec(){
  rec.end = Date.now();
  const r = rec; rec = null;
  $('bRec').classList.remove('recing'); $('bRec').querySelector('span').textContent='record'; $('hRecBox').classList.remove('rec'); $('hDistL').textContent='mi today';
  keepAwake(following);
  if(r.pts.length < 2){ toast('Ride too short to save'); if(recLine) rideLayer.removeLayer(recLine); recLine=null; return; }
  await DB.put('rides', r);
  if(recLine) rideLayer.removeLayer(recLine); recLine=null;
  toast(`Saved ${fmt1(r.dist*1000*M2MI)} mi ride`);
  renderRides();
}
$('bRec').addEventListener('click', ()=>{ if(rec) stopRec(); else startRec(); });
// resume an interrupted recording
(async()=>{ try{ const all = await DB.all('rides'); const open = all.find(r=>!r.end); if(open && Date.now()-open.start < 12*3600e3){ rec = open; recLine = L.polyline(open.pts.map(p=>[p[0],p[1]]), {color:'#ff5c5c', weight:4, opacity:.9}).addTo(rideLayer); $('bRec').classList.add('recing'); $('bRec').querySelector('span').textContent='stop'; $('hRecBox').classList.add('rec'); $('hDistL').textContent='mi ride'; $('hDist').textContent=fmt1(open.dist*1000*M2MI); startGps(); keepAwake(true); toast('Resumed recording'); } else if(open){ open.end = open.start + (open.pts.length? open.pts[open.pts.length-1][3]-open.start : 0); await DB.put('rides', open); } }catch(e){} })();

// ---------- saved rides on map ----------
const shownRides = new Map();
async function showRide(id, on){
  if(!on){ const l = shownRides.get(id); if(l){ rideLayer.removeLayer(l); shownRides.delete(id); } return; }
  const r = await DB.get('rides', id); if(!r) return;
  const pl = L.polyline(r.pts.map(p=>[p[0],p[1]]), {color:'#5bd36a', weight:4, opacity:.85}).bindPopup(`<b>${esc(r.name)}</b><br>${fmt1(r.dist*1000*M2MI)} mi · ${fmtDur((r.end||Date.now())-r.start)}`);
  rideLayer.addLayer(pl); shownRides.set(id, pl); map.fitBounds(pl.getBounds().pad(0.1));
}

// ---------- waypoints ----------
async function renderWaypoints(){
  wpLayer.clearLayers();
  let wps=[]; try{ wps = await DB.all('waypoints'); }catch(e){}
  wps.forEach(w=>{
    L.marker([w.lat,w.lon], {icon:L.divIcon({className:'wp-icon', iconSize:[16,16]})}).bindTooltip(w.name, {permanent:true, direction:'top', offset:[0,-8], className:'wptip'})
      .bindPopup(`<b>${esc(w.name)}</b><br><span class="tag">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</span>${w.note?'<br>'+esc(w.note):''}<br><button class="pbtn" data-act="wp-del" data-id="${w.id}">Delete</button>`).addTo(wpLayer);
  });
}
function openWaypointEditor(ll){
  const id = uid();
  openSheet('New waypoint', `
    <p class="help">${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}</p>
    <input type="text" id="wpName" placeholder="Name (e.g. Steep rock garden, Overlook, Gate)" autocomplete="off">
    <div style="height:8px"></div>
    <input type="text" id="wpNote" placeholder="Note (optional)" autocomplete="off">
    <div class="actions"><button class="sb" id="wpCancel">Cancel</button><button class="sb primary" id="wpSave">Save waypoint</button></div>`);
  $('wpName').focus();
  $('wpCancel').onclick = closeSheet;
  $('wpSave').onclick = async ()=>{ const name = $('wpName').value.trim() || 'Waypoint'; await DB.put('waypoints', {id, name, note:$('wpNote').value.trim(), lat:ll.lat, lon:ll.lng, t:Date.now()}); closeSheet(); renderWaypoints(); toast('Waypoint saved'); };
}
$('bWp').addEventListener('click', ()=>{ const ll = (following && lastFix) ? L.latLng(lastFix.lat,lastFix.lon) : map.getCenter(); openWaypointEditor(ll); });
map.on('contextmenu', e=>{ openWaypointEditor(e.latlng); }); // long-press on Android, right-click on desktop
renderWaypoints();

// ---------- GPX ----------
function gpxOf(rides, wps){
  const h = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Windrock Trails" xmlns="http://www.topografix.com/GPX/1/1">\n`;
  const w = wps.map(p=>`<wpt lat="${p.lat}" lon="${p.lon}"><name>${esc(p.name)}</name>${p.note?`<desc>${esc(p.note)}</desc>`:''}</wpt>`).join('\n');
  const t = rides.map(r=>`<trk><name>${esc(r.name)}</name><trkseg>\n${r.pts.map(p=>`<trkpt lat="${p[0]}" lon="${p[1]}">${p[2]!=null?`<ele>${p[2].toFixed(1)}</ele>`:''}<time>${new Date(p[3]).toISOString()}</time></trkpt>`).join('\n')}\n</trkseg></trk>`).join('\n');
  return h + w + '\n' + t + '\n</gpx>';
}
function download(name, text){
  const blob = new Blob([text], {type:'application/gpx+xml'}); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 1500);
}
async function shareOrDownload(name, text){
  const file = new File([text], name, {type:'application/gpx+xml'});
  if(navigator.canShare && navigator.canShare({files:[file]})){ try{ await navigator.share({files:[file], title:name}); return; }catch(e){ if(e.name==='AbortError') return; } }
  download(name, text);
}
// ---------- trail packs (imported trail maps) ----------
const GARMIN_COLORS = {Black:'#222', DarkRed:'#8b0000', DarkGreen:'#006400', DarkYellow:'#9b870c', DarkBlue:'#00008b', DarkMagenta:'#8b008b', DarkCyan:'#008b8b', LightGray:'#d3d3d3', DarkGray:'#a9a9a9', Red:'#ff3b30', Green:'#34c759', Yellow:'#ffd60a', Blue:'#0a84ff', Magenta:'#ff2d55', Cyan:'#32ade6', White:'#fff'};
function gpxColor(el){
  // Gaia / gpx_style: <color>RRGGBB</color>; Garmin: <DisplayColor>Red</DisplayColor>; OsmAnd: <osmand:color>#RRGGBB</osmand:color>
  const c = el.getElementsByTagNameNS('*','color')[0]; if(c && c.textContent.trim()){ const v=c.textContent.trim().replace(/^#/,''); if(/^[0-9a-f]{6,8}$/i.test(v)) return '#'+v.slice(-6); }
  const g = el.getElementsByTagNameNS('*','DisplayColor')[0]; if(g && GARMIN_COLORS[g.textContent.trim()]) return GARMIN_COLORS[g.textContent.trim()];
  return null;
}
function parseGpx(txt, fallbackName){
  const doc = new DOMParser().parseFromString(txt, 'application/xml');
  if(doc.querySelector('parsererror')) return null;
  const tracks=[], wpts=[];
  const segsOf = el=>Array.from(el.getElementsByTagNameNS('*','trkseg'));
  for(const trk of Array.from(doc.getElementsByTagNameNS('*','trk'))){
    const name = (trk.getElementsByTagNameNS('*','name')[0]||{}).textContent || '';
    const desc = (trk.getElementsByTagNameNS('*','desc')[0]||{}).textContent || '';
    const color = gpxColor(trk);
    for(const seg of segsOf(trk)){
      const pts=[]; for(const p of Array.from(seg.getElementsByTagNameNS('*','trkpt'))){ const la=+p.getAttribute('lat'), lo=+p.getAttribute('lon'); if(isNaN(la)||isNaN(lo)) continue; const el=p.getElementsByTagNameNS('*','ele')[0]; const tm=p.getElementsByTagNameNS('*','time')[0]; const t = tm? Date.parse(tm.textContent) : NaN; pts.push([la,lo, el?+el.textContent:null, isNaN(t)?null:t]); }
      if(pts.length>1) tracks.push({name:name.trim()||fallbackName, desc:desc.trim(), color, pts});
    }
  }
  for(const rte of Array.from(doc.getElementsByTagNameNS('*','rte'))){
    const name = (rte.getElementsByTagNameNS('*','name')[0]||{}).textContent || '';
    const pts = Array.from(rte.getElementsByTagNameNS('*','rtept')).map(p=>[+p.getAttribute('lat'),+p.getAttribute('lon'),null,null]).filter(p=>!isNaN(p[0]));
    if(pts.length>1) tracks.push({name:name.trim()||fallbackName, desc:'', color:gpxColor(rte), pts});
  }
  for(const w of Array.from(doc.getElementsByTagNameNS('*','wpt'))){
    const la=+w.getAttribute('lat'), lo=+w.getAttribute('lon'); if(isNaN(la)||isNaN(lo)) continue;
    wpts.push({name:(w.getElementsByTagNameNS('*','name')[0]||{}).textContent||'Waypoint', note:(w.getElementsByTagNameNS('*','desc')[0]||{}).textContent||'', lat:la, lon:lo});
  }
  return {tracks, wpts};
}
const packLayers = new Map(); // pack id -> layerGroup
async function renderPacks(){
  packLayer.clearLayers(); packLayers.clear();
  let packs=[]; try{ packs = await DB.all('packs'); }catch(e){}
  packs.forEach(pk=>{
    if(pk.hidden) return;
    const g = L.layerGroup();
    pk.tracks.forEach(t=>{
      const pl = L.polyline(t.pts.map(p=>[p[0],p[1]]), {color:t.color||'#ff8a1f', weight:3.5, opacity:.95});
      pl.bindPopup(()=>`<b>${esc(t.name)}</b>${t.desc?'<br>'+esc(t.desc):''}<br><span class="tag">${esc(pk.name)}</span><br><button class="pbtn" data-act="wp-here">Mark here</button>`);
      pl.bindTooltip(t.name, {sticky:true, direction:'top', opacity:.9});
      g.addLayer(pl);
    });
    pk.wpts.forEach(w=>{ L.circleMarker([w.lat,w.lon], {radius:5, color:'#1a1006', weight:1.5, fillColor:'#ffd166', fillOpacity:1}).bindTooltip(w.name, {direction:'top', offset:[0,-6]}).bindPopup(`<b>${esc(w.name)}</b>${w.note?'<br>'+esc(w.note):''}<br><span class="tag">${esc(pk.name)}</span>`).addTo(g); });
    packLayer.addLayer(g); packLayers.set(pk.id, g);
  });
}
function packBounds(pk){ const b = L.latLngBounds([]); pk.tracks.forEach(t=>t.pts.forEach(p=>b.extend([p[0],p[1]]))); pk.wpts.forEach(w=>b.extend([w.lat,w.lon])); return b; }
async function importPack(file){
  status('Reading trail map…', true);
  const txt = await file.text();
  const g = parseGpx(txt, file.name.replace(/\.gpx$/i,''));
  if(!g){ status(''); toast('Could not read that GPX file'); return; }
  if(!g.tracks.length && !g.wpts.length){ status(''); toast('No tracks or waypoints in that file'); return; }
  const pk = {id:uid(), name:file.name.replace(/\.gpx$/i,''), tracks:g.tracks, wpts:g.wpts, t:Date.now(), hidden:false};
  await DB.put('packs', pk);
  await renderPacks();
  status('');
  const miles = g.tracks.reduce((s,t)=>{ let d=0; for(let i=1;i<t.pts.length;i++) d+=havKm(t.pts[i-1],t.pts[i]); return s+d; },0)*1000*M2MI;
  toast(`Added ${g.tracks.length} trails (${fmt1(miles)} mi) and ${g.wpts.length} points`);
  const b = packBounds(pk); if(b.isValid()) map.fitBounds(b.pad(0.05));
  if(sheetOpen==='trails') renderTrailsPanel();
}
async function importRide(file){
  const g = parseGpx(await file.text(), file.name.replace(/\.gpx$/i,''));
  if(!g){ toast('Could not read that GPX file'); return; }
  let n=0;
  for(const t of g.tracks){
    let dist=0; for(let i=1;i<t.pts.length;i++) dist+=havKm(t.pts[i-1],t.pts[i]);
    const times = t.pts.map(p=>p[3]).filter(x=>x);
    const start = times.length? Math.min(...times) : Date.now(), end = times.length? Math.max(...times) : start;
    await DB.put('rides', {id:uid(), name:t.name, start, end, dist, pts:t.pts.map(p=>[p[0],p[1],p[2],p[3]||start]), area:'Imported'}); n++;
  }
  for(const w of g.wpts){ await DB.put('waypoints', {id:uid(), name:w.name, note:w.note, lat:w.lat, lon:w.lon, t:Date.now()}); n++; }
  renderWaypoints(); renderRides(); toast(`Imported ${n} item${n===1?'':'s'}`);
}
let gpxMode = 'ride';
renderPacks();
$('gpxFile').addEventListener('change', e=>{ const f=e.target.files[0]; if(f){ if(gpxMode==='pack') importPack(f); else importRide(f); } e.target.value=''; });

// ---------- sheet ----------
let sheetOpen = null;
function openSheet(title, html, key){ $('sheetTitle').textContent=title; $('sheetBody').innerHTML=html; $('sheet').classList.add('open'); sheetOpen=key||title; ['bTrails','bRides','bOffline'].forEach(id=>$(id).classList.toggle('on', $(id).dataset.key===sheetOpen)); }
function closeSheet(){ $('sheet').classList.remove('open'); sheetOpen=null; ['bTrails','bRides','bOffline'].forEach(id=>$(id).classList.remove('on')); }
$('sheetClose').addEventListener('click', closeSheet);
$('bTrails').dataset.key='trails'; $('bRides').dataset.key='rides'; $('bOffline').dataset.key='offline';
function toggleSheet(key, fn){ if(sheetOpen===key) closeSheet(); else fn(); }

// Trails panel
async function renderTrailsPanel(){
  let packs=[]; try{ packs = await DB.all('packs'); }catch(e){}
  openSheet('Trails & map', `
    <h3 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:4px 0">Your trail maps</h3>
    <p class="help">The best trail data for these parks is not in OpenStreetMap. Import a GPX trail map (the park's own file, a purchased map, or one from another rider) and it becomes a permanent layer that works offline.</p>
    <div class="actions"><button class="sb primary" id="pImport">Import trail map (GPX)</button></div>
    ${packs.map(pk=>`<div class="row"><div class="t"><b>${esc(pk.name)}</b><small>${pk.tracks.length} trails · ${pk.wpts.length} points</small></div><button class="sb" data-pshow="${pk.id}">${pk.hidden?'Show':'Hide'}</button><button class="sb" data-pzoom="${pk.id}">Zoom</button><button class="sb danger" data-pdel="${pk.id}">✕</button></div>`).join('')}
    <h3 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:18px 0 4px">OpenStreetMap trails</h3>
    <p class="help">Trail lines come from OpenStreetMap and load for whatever is on screen once you are zoomed in to about a 1-mile scale. The first load of a new area can take 10 to 20 seconds. Tap a line for its name, number and surface. Areas you have viewed stay cached for offline use.</p>
    <div class="legend"><span><i style="border-color:#ff8a1f"></i>Track / OHV road</span><span><i style="border-color:#ffe066;border-top-style:dashed"></i>Path / singletrack</span><span><i style="border-color:#cfd8d0"></i>Road</span><span><i style="border-color:#ff5c5c"></i>Recording</span><span><i style="border-color:#5bd36a"></i>Saved ride</span></div>
    <div class="actions"><button class="sb ${trailsOn?'primary':''}" id="tToggle">${trailsOn?'Trails on':'Trails off'}</button><button class="sb" id="tReload">Reload this view</button></div>
    <h3 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:18px 0 4px">Base map</h3>
    <div class="grid" id="layerGrid">${Object.entries(LAYERS).map(([k,c])=>`<button class="sb ${k===baseKey?'on':''}" data-layer="${k}">${c.name}<small>${c.sub}</small></button>`).join('')}</div>
    <h3 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:18px 0 4px">Jump to</h3>
    <div class="grid">${AREAS.map(a=>`<button class="sb" data-area="${a.id}">${a.name.split(' (')[0]}<small>${a.name.includes('(')?a.name.split(' (')[1].replace(')',''):''}</small></button>`).join('')}</div>`, 'trails');
  $('pImport').onclick = ()=>{ gpxMode='pack'; $('gpxFile').click(); };
  $('sheetBody').querySelectorAll('[data-pshow]').forEach(b=>b.onclick=async()=>{ const pk = await DB.get('packs', b.dataset.pshow); pk.hidden=!pk.hidden; await DB.put('packs', pk); await renderPacks(); renderTrailsPanel(); });
  $('sheetBody').querySelectorAll('[data-pzoom]').forEach(b=>b.onclick=async()=>{ const pk = await DB.get('packs', b.dataset.pzoom); const bb=packBounds(pk); if(bb.isValid()) map.fitBounds(bb.pad(0.05)); closeSheet(); });
  $('sheetBody').querySelectorAll('[data-pdel]').forEach(b=>b.onclick=async()=>{ if(b.dataset.confirm){ await DB.del('packs', b.dataset.pdel); await renderPacks(); renderTrailsPanel(); } else { b.dataset.confirm='1'; b.textContent='Delete?'; } });
  $('tToggle').onclick = ()=>{ trailsOn=!trailsOn; try{ localStorage.setItem('wt.trails', trailsOn?'1':'0'); }catch(e){} loadTrails(); renderTrailsPanel(); };
  $('tReload').onclick = ()=>{ const cells = gridCells(map.getBounds().pad(0.05)); cells.forEach(c=>{ trailCache.delete(c.key); DB.del('trails', c.key).catch(()=>{}); }); trailFeatures.forEach(pl=>trailLayer.removeLayer(pl)); trailFeatures.clear(); trailRetries=0; loadTrails(); closeSheet(); };
  $('layerGrid').querySelectorAll('[data-layer]').forEach(b=>b.onclick=()=>{ setBase(b.dataset.layer); renderTrailsPanel(); });
  $('sheetBody').querySelectorAll('[data-area]').forEach(b=>b.onclick=()=>{ sel.value=b.dataset.area; goArea(b.dataset.area); closeSheet(); });
}
$('bTrails').addEventListener('click', ()=>toggleSheet('trails', renderTrailsPanel));
$('bLayers').addEventListener('click', ()=>{ const keys=Object.keys(LAYERS); setBase(keys[(keys.indexOf(baseKey)+1)%keys.length]); toast(LAYERS[baseKey].name); });

// Rides panel
async function renderRides(){
  if(sheetOpen && sheetOpen!=='rides') return;
  let rides=[], wps=[]; try{ rides = (await DB.all('rides')).filter(r=>r.end).sort((a,b)=>b.start-a.start); wps = await DB.all('waypoints'); }catch(e){}
  const total = rides.reduce((s,r)=>s+r.dist,0)*1000*M2MI;
  openSheet('Rides & waypoints', `
    <div class="actions"><button class="sb" id="rImport">Import GPX</button><button class="sb" id="rExportAll" ${rides.length||wps.length?'':'disabled'}>Export all (GPX)</button></div>
    <p class="help">${rides.length} ride${rides.length===1?'':'s'} · ${fmt1(total)} mi total · ${wps.length} waypoint${wps.length===1?'':'s'}. Everything is stored on this phone only.</p>
    ${rides.length? rides.map(r=>`<div class="row"><div class="t"><b>${esc(r.name)}</b><small>${fmtDate(r.start)} · ${fmt1(r.dist*1000*M2MI)} mi · ${fmtDur(r.end-r.start)}${r.area?' · '+esc(r.area):''}</small></div><button class="sb" data-show="${r.id}">${shownRides.has(r.id)?'Hide':'Show'}</button><button class="sb" data-exp="${r.id}">GPX</button><button class="sb danger" data-del="${r.id}">✕</button></div>`).join('') : '<p class="help">No rides yet. Tap <b>record</b> on the right rail when you head out.</p>'}
    ${wps.length? '<h3 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:18px 0 0">Waypoints</h3>' + wps.sort((a,b)=>b.t-a.t).map(w=>`<div class="row"><div class="t"><b>${esc(w.name)}</b><small>${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}${w.note?' · '+esc(w.note):''}</small></div><button class="sb" data-go="${w.id}">Go</button><button class="sb danger" data-wdel="${w.id}">✕</button></div>`).join('') : ''}`, 'rides');
  $('rImport').onclick = ()=>{ gpxMode='ride'; $('gpxFile').click(); };
  $('rExportAll').onclick = ()=>shareOrDownload(`windrock-all-${new Date().toISOString().slice(0,10)}.gpx`, gpxOf(rides, wps));
  const body = $('sheetBody');
  body.querySelectorAll('[data-show]').forEach(b=>b.onclick=async()=>{ const id=b.dataset.show; await showRide(id, !shownRides.has(id)); if(shownRides.has(id)) closeSheet(); else renderRides(); });
  body.querySelectorAll('[data-exp]').forEach(b=>b.onclick=async()=>{ const r = rides.find(x=>x.id===b.dataset.exp); shareOrDownload(`${r.name.replace(/[^\w-]+/g,'_')}.gpx`, gpxOf([r], [])); });
  body.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{ if(b.dataset.confirm){ await DB.del('rides', b.dataset.del); showRide(b.dataset.del,false); renderRides(); } else { b.dataset.confirm='1'; b.textContent='Delete?'; } });
  body.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{ const w = wps.find(x=>x.id===b.dataset.go); map.setView([w.lat,w.lon], 16); setFollow(false); closeSheet(); });
  body.querySelectorAll('[data-wdel]').forEach(b=>b.onclick=async()=>{ if(b.dataset.confirm){ await DB.del('waypoints', b.dataset.wdel); renderWaypoints(); renderRides(); } else { b.dataset.confirm='1'; b.textContent='Delete?'; } });
}
$('bRides').addEventListener('click', ()=>toggleSheet('rides', renderRides));

// ---------- offline ----------
let swReg = null;
if('serviceWorker' in navigator){ navigator.serviceWorker.register('sw.js').then(r=>{ swReg=r; }).catch(()=>{}); }
function tileRange(b, z){
  const n = 2**z; const x1=Math.floor((b.getWest()+180)/360*n), x2=Math.floor((b.getEast()+180)/360*n);
  const lat2y = la=>{ const r=la*Math.PI/180; return Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*n); };
  return {x1, x2, y1:lat2y(b.getNorth()), y2:lat2y(b.getSouth())};
}
function tileUrls(b, zmin, zmax, c){
  const urls=[]; const subs = c.sub_||['a','b','c'];
  for(let z=zmin; z<=Math.min(zmax, c.maxZoom); z++){ const r=tileRange(b,z); for(let x=r.x1;x<=r.x2;x++) for(let y=r.y1;y<=r.y2;y++) urls.push(c.url.replace('{z}',z).replace('{x}',x).replace('{y}',y).replace('{s}', subs[(x+y)%subs.length])); }
  return urls;
}
let dlAbort = null;
let dlTarget = 'view'; // 'view' or an area id
async function renderOffline(){
  const c = LAYERS[baseKey];
  const area = AREAS.find(a=>a.id===dlTarget);
  const b = area ? L.latLngBounds([area.bbox[0],area.bbox[1]],[area.bbox[2],area.bbox[3]]) : map.getBounds();
  const z0 = area ? 10 : Math.max(10, Math.min(map.getZoom(), 13));
  const zmax = Math.min(16, c.maxZoom); const urls = tileUrls(b, z0, zmax, c);
  const cap = 20000;
  let cached = 0; try{ if('caches' in window){ const k = await caches.keys(); if(k.includes('wt-tiles')){ cached = (await (await caches.open('wt-tiles')).keys()).length; } } }catch(e){}
  let est = ''; try{ if(navigator.storage && navigator.storage.estimate){ const e = await navigator.storage.estimate(); est = ` · ${Math.round((e.usage||0)/1048576)} MB used of ${Math.round((e.quota||0)/1073741824)} GB available`; } }catch(e){}
  openSheet('Offline maps', `
    <p class="help">Do this at home on Wi-Fi. Pick the base map you ride with, then save a whole park or just what is on screen. Tiles you look at while online are kept automatically too.</p>
    <div class="grid" id="dlTargets"><button class="sb ${dlTarget==='view'?'on':''}" data-target="view">Current view<small>what is on screen now</small></button>${AREAS.filter(a=>a.bbox).map(a=>`<button class="sb ${dlTarget===a.id?'on':''}" data-target="${a.id}">${a.name.split(' (')[0].split(' / ')[0]}<small>whole area</small></button>`).join('')}</div>
    <div class="row"><div class="t"><b>${c.name} · zoom ${z0} to ${zmax}</b><small>${urls.length.toLocaleString()} tiles · roughly ${Math.round(urls.length*18/1024)} MB</small></div><button class="sb" id="dlLayer">Change map</button></div>
    <div class="bar" id="dlBar"><i></i></div>
    <div class="actions"><button class="sb primary" id="dlStart" ${urls.length>cap?'disabled':''}>${urls.length>cap?'Area too large for one save':'Save for offline'}</button><button class="sb" id="dlStop" hidden>Stop</button></div>
    <p class="help" id="dlMsg"></p>
    <div class="row"><div class="t"><b>Stored on this device</b><small>${cached.toLocaleString()} tiles${est}</small></div><button class="sb danger" id="dlClear">Clear tiles</button></div>
    <p class="help">Trail lines for the saved area are cached as well and show with no signal. Install tip: in Chrome tap the menu, then <b>Add to Home screen</b>, so it opens full screen like an app.</p>`, 'offline');
  $('dlTargets').querySelectorAll('[data-target]').forEach(x=>x.onclick=()=>{ dlTarget=x.dataset.target; renderOffline(); });
  $('dlLayer').onclick = ()=>{ const keys=Object.keys(LAYERS); setBase(keys[(keys.indexOf(baseKey)+1)%keys.length]); renderOffline(); };
  $('dlStart').onclick = async ()=>{
    if(!('caches' in window)){ $('dlMsg').textContent='This browser cannot store tiles offline.'; return; }
    try{ if(navigator.storage && navigator.storage.persist) navigator.storage.persist(); }catch(e){}
    const cache = await caches.open('wt-tiles'); let done=0, fail=0; dlAbort = {stop:false};
    $('dlStart').hidden=true; $('dlStop').hidden=false;
    const bar = $('dlBar').firstElementChild; const msg = $('dlMsg');
    msg.textContent = 'Caching trail lines…';
    try{ const need=[]; for(const c of gridCells(b)){ if(!(await cachedCell(c))) need.push(c); } for(let i=0;i<need.length;i+=8){ await queued(()=>fetchCells(need.slice(i,i+8))).catch(()=>{}); } }catch(e){}
    const q = urls.slice(); const workers = Array.from({length:6}, async ()=>{ while(q.length && !dlAbort.stop){ const u=q.shift(); try{ if(!(await cache.match(u))){ const r = await fetch(u, {mode:'cors'}); if(r.ok) await cache.put(u, r); else fail++; } }catch(e){ fail++; } done++; if(done%20===0||!q.length){ bar.style.width=(done/urls.length*100)+'%'; msg.textContent=`${done.toLocaleString()} of ${urls.length.toLocaleString()} tiles${fail?` · ${fail} failed`:''}`; } } });
    await Promise.all(workers);
    bar.style.width='100%'; $('dlStop').hidden=true; $('dlStart').hidden=false;
    msg.textContent = dlAbort.stop ? `Stopped at ${done.toLocaleString()} tiles` : `Saved. ${(done-fail).toLocaleString()} tiles ready offline${fail?`, ${fail} failed (run it again to fill gaps)`:''}.`;
  };
  $('dlStop').onclick = ()=>{ if(dlAbort) dlAbort.stop=true; };
  $('dlClear').onclick = async ()=>{ try{ await caches.delete('wt-tiles'); }catch(e){} renderOffline(); toast('Tile cache cleared'); };
}
$('bOffline').addEventListener('click', ()=>toggleSheet('offline', renderOffline));
window.addEventListener('online', ()=>{ status('Back online'); loadTrails(); });
window.addEventListener('offline', ()=>status('Offline: using saved maps', true));
if(!navigator.onLine) status('Offline: using saved maps', true);

// close sheet on map tap
map.on('click', ()=>{ if(sheetOpen) closeSheet(); });
window.WT = {map, DB, gpxOf, loadTrails, importPack, renderPacks};
})();
