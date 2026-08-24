const PLACEHOLDER = /{{(\w+)}}/g

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
  'trackingAssigned',
]

export const TEMPLATE_LABELS = {
  optInInvite: 'Opt-in invitation',
  optInConfirm: 'Opt-in confirmation (sent when patient replies YES)',
  optOutConfirm: 'Opt-out confirmation (sent when patient replies STOP)',
  nonKeywordRedirect: 'Reply to non-keyword messages',
  outForDelivery: 'Out for delivery',
  delivered: 'Delivered',
  addressIssue: 'Address issue',
  trackingAssigned: 'Tracking number assigned (initial message)',
}

// Delivered shipments never trigger a text — the operator's rule is that a delivered package sends no SMS.
// This list drives the manual Send Text dropdown; the automated trigger map in functions/sms-status-trigger.js
// likewise has no delivered entry, so do not re-add it as an apparent omission.
export const SENDABLE_TEMPLATE_KEYS = ['optInInvite', 'outForDelivery', 'addressIssue']

export const TEMPLATE_DEFAULTS = {
  optInInvite: 'Hi from {{pharmacyName}}! Reply YES to get prescription delivery updates. Reply STOP to opt out.',
  optInConfirm: 'Thanks! You are now subscribed to delivery updates from {{pharmacyName}}. Reply STOP at any time to opt out.',
  optOutConfirm: 'You will no longer receive messages from {{pharmacyName}}. Reply START to opt back in.',
  nonKeywordRedirect: 'This number is for delivery updates only. Reply YES to subscribe or STOP to unsubscribe. For prescription questions, please call us at {{pharmacyPhone}}.',
  outForDelivery: 'Your prescription from {{pharmacyName}} is out for delivery today.',
  delivered: 'Your prescription from {{pharmacyName}} has been delivered.',
  addressIssue: '{{pharmacyName}}: There is an issue with your delivery address. Please call us.',
  trackingAssigned: 'Hi {{patientName}}, your prescription from {{pharmacyName}} is on its way. Track it here: {{trackingUrl}}',
}

// ---- Slice 3 (w8-6 UI): languages + operator-approval drafts ----
// The editor lets an operator maintain EN plus ONE additional language.
export const TEMPLATE_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
]

/**
 * Draft translations for operator approval ONLY. These are surfaced in the
 * editor behind an explicit "Use draft" action — they are NEVER auto-applied
 * and never sent to patients until the operator saves them into
 * settings.templatesByLang[lang][key]. Kept in English-side parity with
 * TEMPLATE_DEFAULTS so placeholders resolve identically.
 */
export const TEMPLATE_DRAFT_TRANSLATIONS = {
  es: {
    optInInvite: 'Hola de {{pharmacyName}}! Responde SÍ para recibir actualizaciones de entrega. Responde STOP para cancelar.',
    optInConfirm: '¡Gracias! Ahora recibirás actualizaciones de entrega de {{pharmacyName}}. Responde STOP en cualquier momento para cancelar.',
    optOutConfirm: 'Ya no recibirás mensajes de {{pharmacyName}}. Responde START para volver a suscribirte.',
    nonKeywordRedirect: 'Este número es solo para actualizaciones de entrega. Responde SÍ para suscribirte o STOP para cancelar. Para preguntas sobre recetas, llámanos al {{pharmacyPhone}}.',
    outForDelivery: 'Tu receta de {{pharmacyName}} está en camino hoy.',
    delivered: 'Tu receta de {{pharmacyName}} ha sido entregada.',
    addressIssue: '{{pharmacyName}}: Hay un problema con la dirección de entrega. Por favor llámanos.',
    trackingAssigned: 'Hola {{patientName}}, tu receta de {{pharmacyName}} está en camino. Síguela aquí: {{trackingUrl}}',
  },
  fr: {
    optInInvite: 'Bonjour de {{pharmacyName}}! Répondez OUI pour recevoir les mises à jour de livraison. Répondez STOP pour vous désabonner.',
    optInConfirm: 'Merci ! Vous êtes maintenant abonné aux mises à jour de livraison de {{pharmacyName}}. Répondez STOP à tout moment pour vous désabonner.',
    optOutConfirm: 'Vous ne recevrez plus de messages de {{pharmacyName}}. Répondez START pour vous réabonner.',
    nonKeywordRedirect: "Ce numéro est réservé aux mises à jour de livraison. Répondez OUI pour vous abonner ou STOP pour vous désabonner. Pour les questions d'ordonnance, appelez-nous au {{pharmacyPhone}}.",
    outForDelivery: "Votre ordonnance de {{pharmacyName}} est en cours de livraison aujourd'hui.",
    delivered: 'Votre ordonnance de {{pharmacyName}} a été livrée.',
    addressIssue: '{{pharmacyName}} : Il y a un problème avec votre adresse de livraison. Veuillez nous appeler.',
    trackingAssigned: 'Bonjour {{patientName}}, votre ordonnance de {{pharmacyName}} est en route. Suivez-la ici : {{trackingUrl}}',
  },
}
