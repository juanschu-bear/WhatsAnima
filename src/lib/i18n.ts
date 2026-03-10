export type Locale = 'en' | 'es'

const STORAGE_KEY = 'wa_locale'

export function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'en' || stored === 'es') return stored
  } catch {}
  return 'en'
}

export function setStoredLocale(locale: Locale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {}
}

const translations = {
  en: {
    ownerConsole: 'Owner Console',
    online: 'Online',
    contacts: 'Contacts',
    conversations: 'Conversations',
    messages: 'Messages',
    avgPerConv: 'Avg / Conv',
    mostActive: 'Most Active',
    noContactYet: 'No contact yet',
    home: 'Home',
    signOut: 'Sign Out',
    liveInbox: 'Live Inbox',
    contactsTitle: 'Contacts',
    observeInteractions: 'Observe every live interaction with the avatar.',
    searchContacts: 'Search contacts',
    noConversationsFound: 'No conversations found.',
    invites: 'Invites',
    inviteManagement: 'Invite management',
    hide: 'Hide',
    show: 'Show',
    optionalInviteLabel: 'Optional invite label',
    generating: 'Generating...',
    generate: 'Generate',
    noInviteLinksYet: 'No invite links yet.',
    untitledInvite: 'Untitled invite',
    uses: 'uses',
    active: 'Active',
    inactive: 'Inactive',
    copyLink: 'Copy Link',
    copied: 'Copied',
    delete: 'Delete',
    selectConversation: 'Select a conversation',
    selectConversationDesc: 'Review every interaction, message flow, and media exchange from one premium owner console.',
    observerMode: 'Observer Mode',
    avatarHandlesReplies: 'The avatar handles replies automatically',
    noMessagesYet: 'No messages in this conversation yet.',
    contact: 'Contact',
    avatar: 'Avatar',
    insights: 'Insights',
    conversationIntelligence: 'Conversation intelligence',
    operationalVisibility: 'Operational visibility for tomorrow\'s presentation.',
    summary: 'Summary',
    mainTopics: 'Main topics',
    topicExtractionNote: 'Topic extraction will become richer as more conversation data accumulates.',
    breakdown: 'Breakdown',
    contactMessages: 'Contact messages',
    avatarReplies: 'Avatar replies',
    conversationDuration: 'Conversation duration',
    perceptionPreview: 'Perception Preview',
    perceptionComingSoon: 'Perception analysis coming soon',
    selectConversationForInsights: 'Select a conversation to reveal the intelligence panel.',
    allOwners: 'All Owners',
    switchOwner: 'Switch owner view',
    viewing: 'Viewing',
  },
  es: {
    ownerConsole: 'Consola del Propietario',
    online: 'En linea',
    contacts: 'Contactos',
    conversations: 'Conversaciones',
    messages: 'Mensajes',
    avgPerConv: 'Prom / Conv',
    mostActive: 'Mas activo',
    noContactYet: 'Sin contactos aun',
    home: 'Inicio',
    signOut: 'Cerrar sesion',
    liveInbox: 'Bandeja en vivo',
    contactsTitle: 'Contactos',
    observeInteractions: 'Observa cada interaccion en vivo con el avatar.',
    searchContacts: 'Buscar contactos',
    noConversationsFound: 'No se encontraron conversaciones.',
    invites: 'Invitaciones',
    inviteManagement: 'Gestion de invitaciones',
    hide: 'Ocultar',
    show: 'Mostrar',
    optionalInviteLabel: 'Etiqueta opcional de invitacion',
    generating: 'Generando...',
    generate: 'Generar',
    noInviteLinksYet: 'Aun no hay enlaces de invitacion.',
    untitledInvite: 'Invitacion sin titulo',
    uses: 'usos',
    active: 'Activo',
    inactive: 'Inactivo',
    copyLink: 'Copiar enlace',
    copied: 'Copiado',
    delete: 'Eliminar',
    selectConversation: 'Selecciona una conversacion',
    selectConversationDesc: 'Revisa cada interaccion, flujo de mensajes e intercambio de medios desde una consola premium.',
    observerMode: 'Modo Observador',
    avatarHandlesReplies: 'El avatar responde automaticamente',
    noMessagesYet: 'Aun no hay mensajes en esta conversacion.',
    contact: 'Contacto',
    avatar: 'Avatar',
    insights: 'Analisis',
    conversationIntelligence: 'Inteligencia conversacional',
    operationalVisibility: 'Visibilidad operativa para la presentacion de manana.',
    summary: 'Resumen',
    mainTopics: 'Temas principales',
    topicExtractionNote: 'El analisis de temas se enriquecera a medida que se acumulen mas datos.',
    breakdown: 'Desglose',
    contactMessages: 'Mensajes del contacto',
    avatarReplies: 'Respuestas del avatar',
    conversationDuration: 'Duracion de la conversacion',
    perceptionPreview: 'Vista previa de percepcion',
    perceptionComingSoon: 'Analisis de percepcion proximamente',
    selectConversationForInsights: 'Selecciona una conversacion para ver el panel de inteligencia.',
    allOwners: 'Todos los Owners',
    switchOwner: 'Cambiar vista de owner',
    viewing: 'Viendo',
  },
} as const

export type TranslationKey = keyof typeof translations.en

export function t(locale: Locale, key: TranslationKey): string {
  return translations[locale][key] ?? translations.en[key] ?? key
}
