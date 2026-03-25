import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

const firebaseConfig = {
  apiKey: 'AIzaSyDDmjQNegYPK3V_hG8MIm3Llbtqfp9lu3A',
  authDomain: 'delivery-manifest-c3deb.firebaseapp.com',
  projectId: 'delivery-manifest-c3deb',
  storageBucket: 'delivery-manifest-c3deb.firebasestorage.app',
  messagingSenderId: '486498814498',
  appId: '1:486498814498:web:c6fc9e9b9cb398c6024d82',
}

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)
export const storage = getStorage(app)
