// main.clean.js - Replacement for main.js (clean)
// Paste this content into main.js (overwrite) or rename this file to main.js after verifying.

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, addDoc, setDoc, deleteDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// ----- CONFIGURE THIS -----
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_STORAGE_BUCKET",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID",
};
// -------------------------

if (!firebaseConfig || !firebaseConfig.projectId) {
  const root = document.getElementById("app") || document.body;
  root.innerHTML = `\n    <div style="padding:20px;font-family:system-ui,Segoe UI,Roboto,Arial;">\n      <h2 style="color:#c00">Firebase config missing</h2>\n      <p>Please open <code>main.js</code> and paste your firebaseConfig values into the <code>firebaseConfig</code> object.</p>\n    </div>\n  `;
  throw new Error("Firebase config is missing in main.clean.js");
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = firebaseConfig.projectId;
const manifestCollectionPath = `/artifacts/${appId}/public/data/manifest`;

function getCentralTimeDateString(date = new Date()) {
  try { return new Date(date.toLocaleString('en-US', { timeZone: 'America/Chicago' })).toISOString().slice(0,10); }
  catch (e) { return new Date().toISOString().slice(0,10); }
}

function showAppError(title, message) { const c = document.getElementById('app') || document.body; c.innerHTML = `<div style="padding:20px;font-family:system-ui,Segoe UI,Roboto,Arial;"><h2 style="color:#c00">${title}</h2><pre style="white-space:pre-wrap">${message}</pre></div>`; }

let unsubscribeSnapshot = null; let latestDocs = [];

function renderTable(data=[]) { const tbody = document.querySelector('#manifest-table-body'); if(!tbody) return; tbody.innerHTML=''; data.forEach(r=>{ const tr=document.createElement('tr'); tr.dataset.id=r.id; tr.innerHTML=`<td>${r.route||''}</td><td>${r.recipient||''}</td><td>${r.address||''}</td><td>${r.status||''}</td><td><button class="edit-btn">Edit</button> <button class="delete-btn">Delete</button></td>`; tbody.appendChild(tr); }); }

async function subscribeToManifest(){ const colRef = collection(db, manifestCollectionPath); const q = query(colRef, orderBy('createdAt','desc')); if(unsubscribeSnapshot) unsubscribeSnapshot(); unsubscribeSnapshot = onSnapshot(q, s=>{ latestDocs=s.docs.map(d=>({id:d.id,...d.data()})); renderTable(latestDocs); }, e=>{ console.error('snapshot',e); showAppError('Listener error',String(e)); }); }

async function addEntry(formEl){ const data={ route: formEl.route?.value||'', recipient: formEl.recipient?.value||'', address: formEl.address?.value||'', status: formEl.status?.value||'', createdAt:new Date().toISOString(), date:getCentralTimeDateString(), }; try{ await addDoc(collection(db,manifestCollectionPath),data); formEl.reset(); }catch(e){ console.error('add',e); showAppError('Write error',String(e)); } }
async function updateEntry(id,updates){ try{ await setDoc(doc(db,manifestCollectionPath,id),updates,{merge:true}); }catch(e){ console.error('update',e); showAppError('Update error',String(e)); } }
async function deleteEntry(id){ try{ await deleteDoc(doc(db,manifestCollectionPath,id)); }catch(e){ console.error('delete',e); showAppError('Delete error',String(e)); } }
function exportToCsv(){ const rows=latestDocs.slice().reverse(); if(!rows.length)return; const header=['route','recipient','address','status','date','createdAt']; const csv=[header.join(',')]; rows.forEach(r=>csv.push(header.map(h=>`"${String(r[h]||'').replace(/"/g,'""')}"`).join(','))); const blob=new Blob([csv.join('\n')],{type:'text/csv'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`manifest-${getCentralTimeDateString()}.csv`; document.body.appendChild(a); a.click(); a.remove(); }

function setupEventListeners(){ const form=document.getElementById('add-entry-form'); if(form) form.addEventListener('submit',e=>{ e.preventDefault(); addEntry(form); }); const tbody=document.querySelector('#manifest-table-body'); if(tbody) tbody.addEventListener('click', e=>{ const tr=e.target.closest('tr'); if(!tr) return; const id=tr.dataset.id; if(e.target.classList.contains('delete-btn')){ if(confirm('Delete this entry?')) deleteEntry(id); } else if(e.target.classList.contains('edit-btn')){ const s=prompt('New status:','delivered'); if(s!=null) updateEntry(id,{status:s}); } }); const exp=document.getElementById('export-csv'); if(exp) exp.addEventListener('click',exportToCsv); }

signInAnonymously(auth).then(()=>onAuthStateChanged(auth,u=>{ if(u) subscribeToManifest(); })).catch(e=>{ console.error('auth',e); showAppError('Authentication error', String(e)); });
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',setupEventListeners); else setupEventListeners();

window.__manifestDebug={ subscribeToManifest, unsubscribeSnapshot:()=>{ if(unsubscribeSnapshot) unsubscribeSnapshot(); }, latestDocs };
