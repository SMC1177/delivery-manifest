import { useState } from 'react'
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from 'firebase/auth'
import { auth } from '../lib/firebase'
import { useToast } from './Toast'

export default function AccountModal({ isOpen, onClose, userName }) {
  const addToast = useToast()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changing, setChanging] = useState(false)

  const isEmailUser = auth.currentUser?.providerData?.some((p) => p.providerId === 'password')

  async function handleChangePassword(e) {
    e.preventDefault()
    if (newPassword !== confirmPassword) {
      addToast('New passwords do not match', 'error')
      return
    }
    if (newPassword.length < 8) {
      addToast('Password must be at least 8 characters', 'error')
      return
    }

    setChanging(true)
    try {
      const user = auth.currentUser
      const credential = EmailAuthProvider.credential(user.email, currentPassword)
      await reauthenticateWithCredential(user, credential)
      await updatePassword(user, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      addToast('Password changed successfully')
      onClose()
    } catch (err) {
      if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        addToast('Current password is incorrect', 'error')
      } else {
        addToast('Failed to change password: ' + err.message, 'error')
      }
    } finally {
      setChanging(false)
    }
  }

  function handleClose() {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4">
        <div className="p-6 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">My Account</h2>
          <button onClick={handleClose} className="text-slate-400 hover:text-slate-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6">
          <div className="mb-6">
            <p className="text-sm text-slate-500">Signed in as</p>
            <p className="text-sm font-medium text-slate-900">{userName || 'User'}</p>
            <p className="text-sm text-slate-500">{auth.currentUser?.email}</p>
          </div>

          {isEmailUser ? (
            <form onSubmit={handleChangePassword} className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-700">Change Password</h3>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Current Password</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Enter current password"
                  autoComplete="current-password"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Confirm New Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Re-enter new password"
                  autoComplete="new-password"
                />
              </div>
              <button
                type="submit"
                disabled={changing || !currentPassword || !newPassword || !confirmPassword}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {changing ? 'Changing…' : 'Change Password'}
              </button>
            </form>
          ) : (
            <p className="text-sm text-slate-500">
              You signed in with Google or Microsoft. Password is managed by your identity provider.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
