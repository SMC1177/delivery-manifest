export default function SessionWarningModal({ remainingSeconds, onDismiss, onSignOut }) {
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm mx-4 text-center">
        <div className="text-4xl mb-4">⏰</div>
        <h2 className="text-lg font-semibold text-gray-900 mb-2">
          Session Expiring Soon
        </h2>
        <p className="text-gray-600 mb-4">
          Your session will expire in{' '}
          <span className="font-bold text-red-600">
            {minutes}:{seconds.toString().padStart(2, '0')}
          </span>
        </p>
        <p className="text-sm text-gray-500 mb-6">
          Click below to stay signed in.
        </p>
        <button
          onClick={onDismiss}
          className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition font-medium mb-3"
        >
          Stay Signed In
        </button>
        {onSignOut && (
          <button
            onClick={onSignOut}
            className="w-full bg-gray-100 text-gray-700 py-2 px-4 rounded-lg hover:bg-gray-200 transition font-medium"
          >
            Sign Out
          </button>
        )}
      </div>
    </div>
  )
}
