import { useState, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { auth, db, storage } from '../lib/firebase'
import { useOrganization } from '../hooks/useOrganization'
import { useInvites } from '../hooks/useInvites'
import { useAuditLog, useAuditLogEntries } from '../hooks/useAuditLog'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import { formatCentralTime } from '../hooks/useShipments'
import TotpSetup from '../components/TotpSetup'

function BrandingSection({ org, slug, updateOrgSettings, logAction, addToast }) {
  const logoInputRef = useRef(null)
  const [uploading, setUploading] = useState(false)

  async function handleLogoUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate file
    const validTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']
    if (!validTypes.includes(file.type)) {
      addToast('Please upload a PNG, JPG, SVG, or WebP image', 'error')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      addToast('Logo must be under 2MB', 'error')
      return
    }

    setUploading(true)
    try {
      const ext = file.name.split('.').pop()
      const storageRef = ref(storage, `organizations/${slug}/logo.${ext}`)
      await uploadBytes(storageRef, file)
      const url = await getDownloadURL(storageRef)
      await updateOrgSettings({ logoUrl: url })
      await logAction('org.logo_updated', slug, { logoUrl: url })
      addToast('Logo uploaded!')
    } catch (err) {
      console.error('Logo upload error:', err)
      addToast('Failed to upload logo: ' + err.message, 'error')
    } finally {
      setUploading(false)
      if (logoInputRef.current) logoInputRef.current.value = ''
    }
  }

  async function handleRemoveLogo() {
    await updateOrgSettings({ logoUrl: null })
    await logAction('org.logo_removed', slug, {})
    addToast('Logo removed')
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
      <h2 className="text-lg font-semibold text-slate-900 mb-4">Branding</h2>
      <div className="space-y-5">
        {/* Logo */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Pharmacy Logo</label>
          <p className="text-xs text-slate-400 mb-3">
            Upload your pharmacy logo. It replaces the pharmacy name text in the header.
          </p>
          <div className="flex items-center gap-4">
            {org?.logoUrl ? (
              <img
                src={org.logoUrl}
                alt="Logo"
                className="h-14 max-w-[200px] rounded-lg object-contain border border-slate-200 bg-white p-1"
              />
            ) : (
              <div className="h-14 w-32 bg-slate-100 rounded-lg flex items-center justify-center border border-dashed border-slate-300">
                <span className="text-slate-400 text-xs">No logo</span>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                onChange={handleLogoUpload}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => logoInputRef.current?.click()}
                disabled={uploading}
                className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {uploading ? 'Uploading...' : org?.logoUrl ? 'Change Logo' : 'Upload Logo'}
              </button>
              {org?.logoUrl && (
                <button
                  type="button"
                  onClick={handleRemoveLogo}
                  className="px-4 py-1.5 text-sm font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors"
                >
                  Remove Logo
                </button>
              )}
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-2">PNG, JPG, SVG, or WebP. Max 2MB.</p>

          {org?.logoUrl && (
            <label className="flex items-center gap-2 mt-3 cursor-pointer">
              <input
                type="checkbox"
                checked={org?.showNameWithLogo || false}
                onChange={async (e) => {
                  await updateOrgSettings({ showNameWithLogo: e.target.checked })
                  addToast(e.target.checked ? 'Name shown with logo' : 'Name hidden — logo only')
                }}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-slate-700">Show pharmacy name alongside logo</span>
            </label>
          )}
        </div>

        {/* Display Name */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Display Name</label>
          <input
            type="text"
            placeholder="Woodlands RX Pharmacy"
            defaultValue={org?.name || ''}
            onBlur={async (e) => {
              const name = e.target.value.trim()
              if (name && name !== (org?.name || '')) {
                await updateOrgSettings({ name })
                addToast('Pharmacy name updated')
                await logAction('org.name_updated', slug, { name })
              }
            }}
            className="w-full max-w-md px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-slate-400 mt-1">Shown in the header when no logo is uploaded.</p>
        </div>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const { slug } = useParams()
  const { org, members, loading, isAdmin, updateMemberRole, removeMember, updateOrgSettings } = useOrganization(slug)
  const { invites, createInvite, deleteInvite } = useInvites(slug)
  const { logAction } = useAuditLog(slug)
  const { entries: auditEntries, loading: auditLoading } = useAuditLogEntries(slug, 50)
  const { userData } = useAuth()
  const addToast = useToast()

  // Member add mode
  const [addMode, setAddMode] = useState('manual') // 'manual' | 'invite'

  // Manual add form
  const [manualName, setManualName] = useState('')
  const [manualEmail, setManualEmail] = useState('')
  const [manualPassword, setManualPassword] = useState('')
  const [manualRole, setManualRole] = useState('staff')
  const [addingMember, setAddingMember] = useState(false)

  // Invite form
  const [inviteRole, setInviteRole] = useState('staff')
  const [inviteMaxUses, setInviteMaxUses] = useState(1)
  const [inviteExpHours, setInviteExpHours] = useState(72)
  const [creatingInvite, setCreatingInvite] = useState(false)
  const [lastCode, setLastCode] = useState('')

  // Audit log expanded
  const [showAudit, setShowAudit] = useState(false)

  // Shipment field config
  const AVAILABLE_FIELDS = [
    { key: 'address', label: 'Address', description: 'Patient delivery address' },
    { key: 'phone', label: 'Phone Number', description: 'Patient phone number' },
    { key: 'dob', label: 'Date of Birth', description: 'Patient date of birth for verification' },
    { key: 'notes', label: 'Notes', description: 'Additional notes per shipment' },
    { key: 'carrier', label: 'Carrier', description: 'Shipping carrier (UPS, FedEx, etc.)' },
    { key: 'redeliver', label: 'Redeliver Flag', description: 'Mark shipments as redelivery' },
  ]

  const enabledFields = org?.settings?.enabledFields || ['notes', 'carrier']

  // Auth provider config
  const AUTH_PROVIDERS = [
    { key: 'email', label: 'Email & Password', description: 'Traditional email/password accounts', icon: '✉️' },
    { key: 'google', label: 'Google Sign-In', description: 'Sign in with Google Workspace or personal accounts', icon: '🔵' },
    { key: 'microsoft', label: 'Microsoft Sign-In', description: 'Sign in with Microsoft 365 or Outlook accounts', icon: '🟦' },
  ]

  const enabledProviders = org?.settings?.authProviders || ['email', 'google']

  async function handleProviderToggle(providerKey) {
    // Must have at least one provider enabled
    const current = new Set(enabledProviders)
    if (current.has(providerKey)) {
      if (current.size <= 1) {
        addToast('At least one sign-in method must be enabled', 'error')
        return
      }
      current.delete(providerKey)
    } else {
      current.add(providerKey)
    }
    const updated = Array.from(current)
    try {
      await updateOrgSettings({ authProviders: updated })
      await logAction('settings.changed', 'authProviders', { authProviders: updated })
      addToast(`${providerKey} sign-in ${current.has(providerKey) ? 'enabled' : 'disabled'}`)
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  async function handleFieldToggle(fieldKey) {
    const current = new Set(enabledFields)
    if (current.has(fieldKey)) {
      current.delete(fieldKey)
    } else {
      current.add(fieldKey)
    }
    const updated = Array.from(current)
    try {
      await updateOrgSettings({ enabledFields: updated })
      await logAction('settings.changed', 'fields', { enabledFields: updated })
      addToast(`Field ${current.has(fieldKey) ? 'enabled' : 'disabled'}`)
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  if (!isAdmin) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Settings</h1>
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-xl p-6">
          <p className="font-medium">Admin access required</p>
          <p className="text-sm mt-1">Only administrators can access organization settings.</p>
        </div>
      </div>
    )
  }

  async function handleManualAdd(e) {
    e.preventDefault()
    if (!manualName.trim() || !manualEmail.trim() || !manualPassword.trim()) {
      addToast('All fields are required', 'error')
      return
    }
    if (manualPassword.length < 6) {
      addToast('Password must be at least 6 characters', 'error')
      return
    }
    setAddingMember(true)
    try {
      // Use a secondary Firebase app to create user without signing out admin
      const { initializeApp, deleteApp } = await import('firebase/app')
      const { getAuth: getAuth2, createUserWithEmailAndPassword: createUser, sendEmailVerification } = await import('firebase/auth')
      const { doc: docRef, setDoc: setDocFn, serverTimestamp: st } = await import('firebase/firestore')

      const secondaryApp = initializeApp(
        JSON.parse(JSON.stringify(auth.app.options)),
        'secondary-' + Date.now()
      )
      const secondaryAuth = getAuth2(secondaryApp)

      const cred = await createUser(secondaryAuth, manualEmail.trim(), manualPassword.trim())
      const newUid = cred.user.uid

      // Send verification email
      await sendEmailVerification(cred.user)

      // Create user profile
      await setDocFn(docRef(db, 'userProfiles', newUid), {
        email: manualEmail.trim(),
        name: manualName.trim(),
        orgSlug: slug,
        role: manualRole,
        mfaEnrolled: false,
        createdAt: st(),
        createdBy: userData?.name || 'admin',
      })

      // Add as org member
      await setDocFn(docRef(db, 'organizations', slug, 'members', newUid), {
        name: manualName.trim(),
        email: manualEmail.trim(),
        role: manualRole,
        mfaEnrolled: false,
        joinedAt: st(),
        addedBy: userData?.name || 'admin',
      })

      // Sign out of secondary app and clean up
      await secondaryAuth.signOut()
      await deleteApp(secondaryApp)

      await logAction('member.added', newUid, { name: manualName.trim(), email: manualEmail.trim(), role: manualRole })
      addToast(`${manualName.trim()} added successfully. Verification email sent.`)
      setManualName('')
      setManualEmail('')
      setManualPassword('')
      setManualRole('staff')
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') {
        addToast('That email is already registered', 'error')
      } else {
        addToast(err.message, 'error')
      }
    } finally {
      setAddingMember(false)
    }
  }

  async function handleCreateInvite(e) {
    e.preventDefault()
    setCreatingInvite(true)
    try {
      const code = await createInvite({
        role: inviteRole,
        maxUses: Number(inviteMaxUses),
        expiresInHours: Number(inviteExpHours),
      })
      setLastCode(code)
      await logAction('member.invited', code, { role: inviteRole })
      addToast('Invite created')
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setCreatingInvite(false)
    }
  }

  async function handleDeleteInvite(inviteId) {
    try {
      await deleteInvite(inviteId)
      addToast('Invite deleted')
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  async function handleRoleChange(memberId, role) {
    try {
      await updateMemberRole(memberId, role)
      await logAction('settings.changed', memberId, { field: 'role', value: role })
      addToast('Role updated')
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  async function handleRemoveMember(memberId, memberName) {
    if (!confirm(`Remove ${memberName} from the organization?`)) return
    try {
      await removeMember(memberId)
      await logAction('member.removed', memberId, { name: memberName })
      addToast('Member removed')
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  function copyInviteLink(code) {
    const link = `${window.location.origin}/${slug}/join?code=${code}`
    navigator.clipboard.writeText(link)
    addToast('Invite link copied to clipboard')
  }

  const actionLabels = {
    'shipment.created': 'Created shipment',
    'shipment.updated': 'Updated shipment',
    'shipment.deleted': 'Deleted shipment',
    'shipment.status_changed': 'Changed status',
    'member.invited': 'Invited member',
    'member.added': 'Added member',
    'member.removed': 'Removed member',
    'settings.changed': 'Changed settings',
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-6">Settings</h1>

      {/* Organization Info */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Organization</h2>
        {loading ? (
          <div className="animate-pulse h-6 bg-slate-200 rounded w-48"></div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">
              <span className="text-slate-500">Name:</span>{' '}
              <span className="font-medium text-slate-900">{org?.name || '—'}</span>
            </p>
            <p className="text-sm">
              <span className="text-slate-500">Slug:</span>{' '}
              <span className="font-medium text-slate-900 font-mono">{org?.slug || slug}</span>
            </p>
            <p className="text-sm">
              <span className="text-slate-500">Members:</span>{' '}
              <span className="font-medium text-slate-900">{members.length}</span>
            </p>
          </div>
        )}
      </div>

      {/* Branding */}
      {isAdmin && (
        <BrandingSection
          org={org}
          slug={slug}
          updateOrgSettings={updateOrgSettings}
          logAction={logAction}
          addToast={addToast}
        />
      )}

      {/* 2FA Setup */}
      {userData && !userData.mfaEnrolled && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
          <TotpSetup
            onComplete={() => addToast('2FA enabled successfully! 🔐')}
          />
        </div>
      )}

      {userData?.mfaEnrolled && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
          <div className="flex items-center gap-3">
            <div className="text-2xl">🔐</div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Two-Factor Authentication</h3>
              <p className="text-sm text-green-600 font-medium">Enabled — Authenticator App</p>
            </div>
          </div>
        </div>
      )}

      {/* Sign-In Methods */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-2">Sign-In Methods</h2>
        <p className="text-sm text-slate-500 mb-4">
          Control which sign-in options are available for your organization's members.
        </p>
        <div className="space-y-3">
          {AUTH_PROVIDERS.map((provider) => (
            <label
              key={provider.key}
              className="flex items-center justify-between p-3 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className="text-xl">{provider.icon}</span>
                <div>
                  <span className="text-sm font-medium text-slate-900">{provider.label}</span>
                  <p className="text-xs text-slate-500">{provider.description}</p>
                </div>
              </div>
              <div className="relative">
                <input
                  type="checkbox"
                  checked={enabledProviders.includes(provider.key)}
                  onChange={() => handleProviderToggle(provider.key)}
                  className="sr-only peer"
                />
                <div className="w-10 h-6 bg-slate-200 rounded-full peer-checked:bg-blue-600 transition-colors"></div>
                <div className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow peer-checked:translate-x-4 transition-transform"></div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Shipment Fields */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-2">Shipment Fields</h2>
        <p className="text-sm text-slate-500 mb-4">
          Choose which optional fields appear on shipments. Core fields (Date, Patient Name, Rx Numbers, Tracking #, Status) are always shown.
        </p>
        <div className="space-y-3">
          {AVAILABLE_FIELDS.map((field) => (
            <label
              key={field.key}
              className="flex items-center justify-between p-3 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer transition-colors"
            >
              <div>
                <span className="text-sm font-medium text-slate-900">{field.label}</span>
                <p className="text-xs text-slate-500">{field.description}</p>
              </div>
              <div className="relative">
                <input
                  type="checkbox"
                  checked={enabledFields.includes(field.key)}
                  onChange={() => handleFieldToggle(field.key)}
                  className="sr-only peer"
                />
                <div className="w-10 h-6 bg-slate-200 rounded-full peer-checked:bg-blue-600 transition-colors"></div>
                <div className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow peer-checked:translate-x-4 transition-transform"></div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Members List */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Members</h2>
        {loading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="animate-pulse flex gap-4">
                <div className="h-4 bg-slate-200 rounded w-32"></div>
                <div className="h-4 bg-slate-200 rounded w-48"></div>
                <div className="h-4 bg-slate-200 rounded w-20"></div>
              </div>
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 uppercase text-xs tracking-wider">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Email</th>
                  <th className="pb-2 font-medium">Role</th>
                  <th className="pb-2 font-medium">2FA</th>
                  <th className="pb-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="py-3 font-medium text-slate-900">{m.name}</td>
                    <td className="py-3 text-slate-600">{m.email}</td>
                    <td className="py-3">
                      <select
                        value={m.role}
                        onChange={(e) => handleRoleChange(m.id, e.target.value)}
                        className="text-sm border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      >
                        <option value="admin">Admin</option>
                        <option value="staff">Staff</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    </td>
                    <td className="py-3">
                      {m.mfaEnrolled ? (
                        <span className="text-green-600 text-xs font-medium">Enabled</span>
                      ) : (
                        <span className="text-slate-400 text-xs">Off</span>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <button
                        onClick={() => handleRemoveMember(m.id, m.name)}
                        className="text-red-600 hover:text-red-800 text-xs font-medium"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add Members */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Add Members</h2>

        {/* Toggle */}
        <div className="flex gap-1 mb-6 bg-slate-100 rounded-lg p-1 w-fit">
          <button
            onClick={() => setAddMode('manual')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              addMode === 'manual' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Manual Setup
          </button>
          <button
            onClick={() => setAddMode('invite')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              addMode === 'invite' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Invite Link
          </button>
        </div>

        {/* Manual Add Form */}
        {addMode === 'manual' && (
          <form onSubmit={handleManualAdd} className="space-y-3 mb-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Full Name</label>
                <input
                  type="text"
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder="John Doe"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <input
                  type="email"
                  value={manualEmail}
                  onChange={(e) => setManualEmail(e.target.value)}
                  placeholder="john@example.com"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Temporary Password</label>
                <input
                  type="text"
                  value={manualPassword}
                  onChange={(e) => setManualPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                  minLength={6}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Role</label>
                <select
                  value={manualRole}
                  onChange={(e) => setManualRole(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="admin">Admin</option>
                  <option value="staff">Staff</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              A verification email will be sent. The user can change their password after first login.
            </p>
            <button
              type="submit"
              disabled={addingMember}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {addingMember ? 'Creating Account...' : 'Create Account'}
            </button>
          </form>
        )}

        {/* Invite Form */}
        {addMode === 'invite' && (
          <>
        <form onSubmit={handleCreateInvite} className="flex flex-col sm:flex-row gap-3 mb-4">
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="staff">Staff</option>
            <option value="viewer">Viewer</option>
          </select>
          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-600 whitespace-nowrap">Max uses:</label>
            <input
              type="number"
              min="0"
              value={inviteMaxUses}
              onChange={(e) => setInviteMaxUses(e.target.value)}
              className="w-20 px-2 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-xs text-slate-400">(0 = unlimited)</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-600 whitespace-nowrap">Expires in:</label>
            <select
              value={inviteExpHours}
              onChange={(e) => setInviteExpHours(e.target.value)}
              className="px-2 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={24}>24 hours</option>
              <option value={72}>3 days</option>
              <option value={168}>7 days</option>
              <option value={720}>30 days</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={creatingInvite}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {creatingInvite ? 'Creating...' : 'Generate Invite'}
          </button>
        </form>

        {lastCode && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-sm text-green-800 mb-1">Invite created! Share this link:</p>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-white px-2 py-1 rounded border border-green-200 flex-1 truncate">
                {window.location.origin}/{slug}/join?code={lastCode}
              </code>
              <button
                onClick={() => copyInviteLink(lastCode)}
                className="text-xs font-medium text-green-700 hover:text-green-800 px-2 py-1 bg-green-100 rounded"
              >
                Copy
              </button>
            </div>
          </div>
        )}

        {/* Active invites */}
        {invites.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-slate-700 mb-2">Active Invites</h3>
            <div className="space-y-2">
              {invites.map((inv) => {
                const expired = inv.expiresAt?.toDate
                  ? inv.expiresAt.toDate() < new Date()
                  : new Date(inv.expiresAt) < new Date()
                return (
                  <div
                    key={inv.id}
                    className={`flex items-center justify-between p-3 rounded-lg border text-sm ${
                      expired ? 'bg-slate-50 border-slate-200 opacity-60' : 'bg-white border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-3 flex-wrap">
                      <code className="text-xs font-mono bg-slate-100 px-2 py-0.5 rounded">
                        {inv.code}
                      </code>
                      <span className="text-slate-600">{inv.role}</span>
                      <span className="text-slate-400">
                        {inv.usedCount}/{inv.maxUses || '\u221E'} used
                      </span>
                      {expired && <span className="text-red-500 text-xs">Expired</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      {!expired && (
                        <button
                          onClick={() => copyInviteLink(inv.code)}
                          className="text-blue-600 hover:text-blue-800 text-xs font-medium"
                        >
                          Copy Link
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteInvite(inv.id)}
                        className="text-red-600 hover:text-red-800 text-xs font-medium"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
          </>
        )}
      </div>

      {/* Audit Log */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-slate-900">Audit Log</h2>
          <button
            onClick={() => setShowAudit(!showAudit)}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium"
          >
            {showAudit ? 'Hide' : 'Show'}
          </button>
        </div>

        {showAudit && (
          <>
            {auditLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
              </div>
            ) : auditEntries.length === 0 ? (
              <p className="text-sm text-slate-500">No audit log entries yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 uppercase text-xs tracking-wider">
                      <th className="pb-2 font-medium">Time</th>
                      <th className="pb-2 font-medium">User</th>
                      <th className="pb-2 font-medium">Action</th>
                      <th className="pb-2 font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {auditEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td className="py-2 text-slate-500 text-xs whitespace-nowrap">
                          {entry.timestamp ? formatCentralTime(entry.timestamp) : '—'}
                        </td>
                        <td className="py-2 text-slate-700">{entry.userName}</td>
                        <td className="py-2">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
                            {actionLabels[entry.action] || entry.action}
                          </span>
                        </td>
                        <td className="py-2 text-slate-500 text-xs max-w-[200px] truncate">
                          {entry.details?.patientName ||
                            entry.details?.name ||
                            entry.targetId ||
                            '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
