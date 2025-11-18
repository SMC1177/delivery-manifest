// Firebase SDK imports
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, addDoc, setDoc, deleteDoc, query, orderBy, updateDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// ----- CONFIGURE THIS -----
// NOTE: Firebase Auth/Firestore will automatically use the initial auth token
// when the app is running in the Canvas environment.
const firebaseConfig = {
    apiKey: "AIzaSyDDmjQNegYPK3V_hG8MIm3Llbtqfp9lu3A",
    authDomain: "delivery-manifest-c3deb.firebaseapp.com",
    projectId: "delivery-manifest-c3deb",
    storageBucket: "delivery-manifest-c3deb.firebasestorage.app",
    messagingSenderId: "510175345991",
    appId: "1:510175345991:web:278310c10426dfe0066062",
};
// -------------------------

// --- APP INITIALIZATION ---

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = firebaseConfig.projectId;
const manifestCollectionPath = `/artifacts/${appId}/public/data/manifest`;

let unsubscribeSnapshot = null;
let latestDocs = [];
let editingEntryId = null; // State to track which row is being edited
let entryToDeleteId = null; // State to track the entry selected for deletion

// DOM Elements
const tableBody = document.querySelector('#manifest-table-body');
const loader = document.getElementById('loader');
const appContent = document.getElementById('app-content');
const deleteModal = document.getElementById('delete-confirm-modal');
const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
const cancelDeleteBtn = document.getElementById('cancel-delete-btn');
const modalText = document.getElementById('modal-text');
const emptyState = document.getElementById('empty-state');
const exportBtn = document.getElementById('export-btn');
const searchInput = document.getElementById('search-input');

// --- HELPER FUNCTIONS ---

function getCentralTimeDateString(date = new Date()) {
    try {
        const options = { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Chicago' };
        const formatter = new Intl.DateTimeFormat('en-US', options);
        const parts = formatter.formatToParts(date);
        const year = parts.find(part => part.type === 'year').value;
        const month = parts.find(part => part.type === 'month').value;
        const day = parts.find(part => part.type === 'day').value;
        return `${year}-${month}-${day}`;
    } catch (e) {
        console.warn("Timezone error, falling back to local date.", e);
        return date.toISOString().slice(0, 10);
    }
}

function showAppError(title, message) {
    loader.style.display = 'none';
    appContent.innerHTML = `<div class="text-center p-8 text-red-600 bg-red-50 rounded-xl border border-red-200">
                                <h2 class="text-xl font-bold mb-2">${title}</h2>
                                <p>${message}</p>
                            </div>`;
    appContent.classList.remove('hidden');
}

// --- CORE DATA OPERATIONS (FIRESTORE) ---

async function subscribeToManifest() {
    const colRef = collection(db, manifestCollectionPath);
    // NOTE: orderBy() is generally avoided in production to prevent runtime errors related to indexing.
    // We will fetch all data and sort it locally.
    const q = query(colRef); 

    if (unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = onSnapshot(q, snap => {
        loader.style.display = 'none'; 
        appContent.classList.remove('hidden'); 

        latestDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // Local sorting by date (newest first)
        latestDocs.sort((a, b) => new Date(b.date) - new Date(a.date));

        renderTable(latestDocs);
    }, err => {
        console.error('Snapshot error', err);
        showAppError('Listener Error', 'Could not subscribe to the manifest data. Check your Firebase rules.', String(err));
    });
}

async function addEntry(formEl) {
    const rxNumbersRaw = formEl.rxNumbers.value.trim();
    const data = {
        date: formEl.date.value, // Maps to #date input
        patientName: formEl.patientName.value.trim(), // Maps to #patientName input
        rxNumbers: rxNumbersRaw.split(',').map(rx => rx.trim()).filter(rx => rx), // Maps to #rxNumbers input
        trackingNumber: formEl.trackingNumber.value.trim(), // Maps to #trackingNumber input
        createdAt: new Date().toISOString(),
    };
    try { 
        await addDoc(collection(db, manifestCollectionPath), data); 
        formEl.reset(); 
        document.getElementById('date').value = getCentralTimeDateString(); // Reset date to today
        document.getElementById('patientName').focus();
    }
    catch (e) { 
        console.error('Add error', e); 
    }
}

async function updateEntry(id, updates) {
    // Ensure rxNumbers is an array of trimmed strings before saving
    if (updates.rxNumbers && typeof updates.rxNumbers === 'string') {
        updates.rxNumbers = updates.rxNumbers.split(',').map(rx => rx.trim()).filter(rx => rx);
    }
    try { 
        await updateDoc(doc(db, manifestCollectionPath, id), updates); 
    }
    catch (e) { 
        console.error('Update error', e); 
    }
}

async function deleteEntry(id) {
    try { 
        await deleteDoc(doc(db, manifestCollectionPath, id)); 
    }
    catch (e) { 
        console.error('Delete error', e); 
    }
}

// --- UI RENDERING & EVENT HANDLING ---

function renderTable(data = latestDocs) {
    if (!tableBody) return;
    tableBody.innerHTML = '';

    if (data.length === 0) {
        emptyState.classList.remove('hidden');
    } else {
        emptyState.classList.add('hidden');
        
        data.forEach(entry => {
            const row = document.createElement('tr');
            row.className = 'hover:bg-slate-50';
            const isEditing = entry.id === editingEntryId;

            const rxString = Array.isArray(entry.rxNumbers) ? entry.rxNumbers.join(', ') : '';
            const trackingLink = entry.trackingNumber ?
                `<a href="https://www.ups.com/track?tracknum=${entry.trackingNumber}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:text-blue-800 hover:underline" title="Track on UPS">${entry.trackingNumber}</a>` :
                '<span class="text-slate-400">N/A</span>';


            if (isEditing) {
                row.innerHTML = `
                    <td class="p-2"><input type="date" value="${entry.date}" class="edit-input" name="date"></td>
                    <td class="p-2"><input type="text" value="${entry.patientName}" class="edit-input" name="patientName"></td>
                    <td class="p-2"><input type="text" value="${rxString}" class="edit-input" name="rxNumbers"></td>
                    <td class="p-2"><input type="text" value="${entry.trackingNumber}" class="edit-input" name="trackingNumber"></td>
                    <td class="p-2 text-right whitespace-nowrap">
                        <button data-id="${entry.id}" class="save-btn text-green-600 hover:text-green-800 font-medium p-1 rounded-full hover:bg-green-100 transition-colors" aria-label="Save entry">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" /></svg>
                        </button>
                        <button data-id="${entry.id}" class="cancel-btn text-slate-500 hover:text-slate-700 font-medium p-1 rounded-full hover:bg-slate-100 transition-colors" aria-label="Cancel edit">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
                        </button>
                    </td>
                `;
            } else {
                row.innerHTML = `
                    <td class="p-4 whitespace-nowrap">${entry.date}</td>
                    <td class="p-4 font-medium text-slate-900">${entry.patientName}</td>
                    <td class="p-4 whitespace-nowrap">${rxString}</td>
                    <td class="p-4 font-mono text-sm text-slate-600 whitespace-nowrap">${trackingLink}</td>
                    <td class="p-4 text-right whitespace-nowrap">
                        <button data-id="${entry.id}" class="edit-btn text-blue-600 hover:text-blue-800 font-medium p-1 rounded-full hover:bg-blue-100 transition-colors" aria-label="Edit entry">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" /><path fill-rule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clip-rule="evenodd" /></svg>
                        </button>
                        <button data-id="${entry.id}" class="delete-btn text-red-600 hover:text-red-800 font-medium p-1 rounded-full hover:bg-red-100 transition-colors" aria-label="Delete entry">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd" /></svg>
                        </button>
                    </td>
                `;
            }
            tableBody.appendChild(row);
        });
    }
}

function handleTableClick(e) {
    const target = e.target.closest('button');
    if (!target) return;
    const id = target.dataset.id;
    const row = target.closest('tr');

    if (target.classList.contains('delete-btn')) {
        entryToDeleteId = id;
        const entry = latestDocs.find(e => e.id === id);
        if (entry) {
            modalText.textContent = `Are you sure you want to delete the entry for ${entry.patientName} on ${entry.date}? This action cannot be undone.`;
        }
        deleteModal.classList.remove('hidden');
        deleteModal.classList.add('modal-enter-active');

    } else if (target.classList.contains('edit-btn')) {
        editingEntryId = id;
        renderTable();
        // Custom CSS for inline editing is applied via the .edit-input class in HTML 
        // which uses Tailwind @apply, so no need for JS styling here.
        
    } else if (target.classList.contains('cancel-btn')) {
        editingEntryId = null;
        renderTable();

    } else if (target.classList.contains('save-btn')) {
        const updatedData = {
            date: row.querySelector('input[name="date"]').value,
            patientName: row.querySelector('input[name="patientName"]').value,
            rxNumbers: row.querySelector('input[name="rxNumbers"]').value, // Send as string, updateEntry formats it
            trackingNumber: row.querySelector('input[name="trackingNumber"]').value,
        };
        updateEntry(id, updatedData)
            .then(() => { editingEntryId = null; })
            .catch(error => console.error("Error saving edit: ", error));
    }
}

function closeDeleteModal() {
    entryToDeleteId = null;
    deleteModal.classList.add('hidden');
    deleteModal.classList.remove('modal-enter-active');
}

const handleDeleteConfirmation = async () => {
    if (entryToDeleteId) {
        try {
            await deleteEntry(entryToDeleteId);
        } catch (error) {
            console.error("Error deleting document: ", error);
        } finally {
            closeDeleteModal();
        }
    }
};


function exportToCsv() {
    const data = latestDocs.slice().reverse(); if (!data.length) return;
    const headers = ['Date', 'Patient Name', 'RX #(s)', 'Tracking Number'];
    const escapeCsvCell = (cell) => `"${String(cell).replace(/"/g,'""')}"`;

    const rows = data.map(entry => 
        [
            entry.date, 
            escapeCsvCell(entry.patientName), 
            escapeCsvCell(Array.isArray(entry.rxNumbers) ? entry.rxNumbers.join(', ') : ''), 
            escapeCsvCell(entry.trackingNumber)
        ].join(',')
    );
    
    let csvContent = headers.join(',') + "\n" + rows.join("\n");

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8,' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `delivery_manifest_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link); 
    link.click();
    document.body.removeChild(link);
}

// --- SEARCH/FILTER FEATURE ---
function filterManifestTable() {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
        renderTable(latestDocs);
        return;
    }
    const filtered = latestDocs.filter(entry => {
        return (
            (entry.patientName && entry.patientName.toLowerCase().includes(query)) ||
            (Array.isArray(entry.rxNumbers) && entry.rxNumbers.join(', ').toLowerCase().includes(query)) ||
            (entry.trackingNumber && entry.trackingNumber.toLowerCase().includes(query))
        );
    });
    renderTable(filtered);
}

function setupEventListeners(){
    // Form submission
    const form = document.getElementById('manifest-form'); 
    if (form) form.addEventListener('submit', e=>{ e.preventDefault(); addEntry(form); });
    
    // Table click (Edit/Delete/Save/Cancel)
    if (tableBody) tableBody.addEventListener('click', handleTableClick);

    // Export button
    if (exportBtn) exportBtn.addEventListener('click', exportToCsv);

    // Modal buttons
    confirmDeleteBtn.addEventListener('click', handleDeleteConfirmation);
    cancelDeleteBtn.addEventListener('click', closeDeleteModal);
    deleteModal.addEventListener('click', (e) => {
        if (e.target === deleteModal) closeDeleteModal();
    });

    // Set today's date on the form
    const dateInput = document.getElementById('date');
    if (dateInput) dateInput.value = getCentralTimeDateString();

    // Search input
    if (searchInput) {
        searchInput.addEventListener('input', filterManifestTable);
    }

    // Initial table rendering (though subscription will overwrite it)
    renderTable(latestDocs);
}

// --- INITIAL AUTHENTICATION AND DATA LOAD ---

signInAnonymously(auth)
    .then(() => onAuthStateChanged(auth, u => { 
        if(u) subscribeToManifest(); 
    }))
    .catch(e => { 
        console.error('Auth error',e); 
        showAppError('Authentication Error', 'Could not sign in anonymously to Firebase. Please check your project settings.', String(e)); 
    });

// Run setup after the DOM is loaded
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupEventListeners); 
else setupEventListeners();

// Debug helper (optional)
window.__manifestDebug = { subscribeToManifest, unsubscribeSnapshot: () => { if (unsubscribeSnapshot) unsubscribeSnapshot(); }, latestDocs };