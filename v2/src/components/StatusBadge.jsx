const statusStyles = {
  pending: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  shipped: 'bg-blue-100 text-blue-800 border-blue-200',
  in_transit: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  delivered: 'bg-green-100 text-green-800 border-green-200',
  exception: 'bg-red-100 text-red-800 border-red-200',
}

const statusLabels = {
  pending: 'Pending',
  shipped: 'Shipped',
  in_transit: 'In Transit',
  delivered: 'Delivered',
  exception: 'Exception',
}

export default function StatusBadge({ status }) {
  const style = statusStyles[status] || statusStyles.pending
  const label = statusLabels[status] || status

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${style}`}>
      {label}
    </span>
  )
}
