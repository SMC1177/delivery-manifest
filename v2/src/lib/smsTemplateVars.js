const PLACEHOLDER = /\{\{(\w+)\}\}/g

export function previewTemplate(template, vars) {
  return template.replace(PLACEHOLDER, (_, name) => vars[name] ?? `{{${name}}}`)
}

export const TEMPLATE_KEYS = [
  'optInInvite',
  'optInConfirm',
  'optOutConfirm',
  'nonKeywordRedirect',
  'outForDelivery',
  'delivered',
  'addressIssue',
]

export const TEMPLATE_LABELS = {
  optInInvite: 'Opt-in invitation',
  optInConfirm: 'Opt-in confirmation (sent when patient replies YES)',
  optOutConfirm: 'Opt-out confirmation (sent when patient replies STOP)',
  nonKeywordRedirect: 'Reply to non-keyword messages',
  outForDelivery: 'Out for delivery',
  delivered: 'Delivered',
  addressIssue: 'Address issue',
}

export const SENDABLE_TEMPLATE_KEYS = ['optInInvite', 'outForDelivery', 'delivered', 'addressIssue']

export const TEMPLATE_DEFAULTS = {
  optInInvite: 'Hi from {{pharmacyName}}! Reply YES to get prescription delivery updates. Reply STOP to opt out.',
  optInConfirm: 'Thanks! You are now subscribed to delivery updates from {{pharmacyName}}. Reply STOP at any time to opt out.',
  optOutConfirm: 'You will no longer receive messages from {{pharmacyName}}. Reply START to opt back in.',
  nonKeywordRedirect: 'This number is for delivery updates only. Reply YES to subscribe or STOP to unsubscribe. For prescription questions, please call us at {{pharmacyPhone}}.',
  outForDelivery: 'Your prescription from {{pharmacyName}} is out for delivery today.',
  delivered: 'Your prescription from {{pharmacyName}} has been delivered.',
  addressIssue: '{{pharmacyName}}: There is an issue with your delivery address. Please call us.',
}
