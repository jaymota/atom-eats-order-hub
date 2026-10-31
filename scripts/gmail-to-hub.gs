// Google Apps Script, pasted into script.google.com while logged in as sales@atomconsulting.in.
// Every 15 minutes it sends new PO / GRN emails (with attachments) to the Order Hub.
// It only reads: it never changes, deletes or sends anything in the mailbox.
// HUB_KEY is secret: the real script (with the key filled in) is given to Jay privately, never in this repo.

const HUB_URL = 'https://zpshpatshvvmcoyhmsrk.supabase.co/functions/v1/inbox'
const HUB_KEY = 'PASTE-THE-KEY-HERE'

// Always sent: the chains' PO addresses, and anything the team sends or forwards to sales@.
// From anyone else, only emails that look like a PO or GRN ("PO", "PO_ZHPL…", "Purchase Order", "GRN").
const PO_SENDERS = /partnersbiz\.com|foodstories\.shop|landcraftretail\.com/i
const TEAM = /@(atomconsulting\.in|atomeats\.com)$/i
const LOOKS_LIKE_PO = /(^|[^a-z])(p\.?\s?o\.?|purchase\s*order|grn|indent)([^a-z]|$)/i
const FILE_OK = /\.(pdf|xlsx?|csv|png|jpe?g|webp)$/i

function sendNewEmails() {
  let found = 0
  const props = PropertiesService.getScriptProperties()
  const sent = JSON.parse(props.getProperty('sent') || '[]')
  const threads = GmailApp.search('has:attachment newer_than:2d -in:spam -in:trash -in:chats', 0, 50)
  console.log('Emails with attachments in the last 2 days: ' + threads.length)
  for (const t of threads) {
    for (const m of t.getMessages()) {
      const id = m.getId()
      if (sent.indexOf(id) >= 0 || Date.now() - m.getDate().getTime() > 3 * 86400000) continue
      const from = m.getFrom()
      if (/sales@atomconsulting\.in/i.test(from)) continue // mail sales@ sent itself (e.g. invoices)
      const email = ((from.match(/<([^>]+)>/) || [])[1] || from).trim()
      const files = m.getAttachments({ includeInlineImages: false }).filter((a) => FILE_OK.test(a.getName()) && a.getSize() < 10 * 1024 * 1024)
      const names = files.map((a) => a.getName()).join(' ')
      if (!files.length) { console.log('Skipped (no PDF / Excel / photo): ' + m.getSubject()); continue }
      if (!(PO_SENDERS.test(email) || TEAM.test(email) || PO_SENDERS.test(m.getPlainBody().slice(0, 3000)) || LOOKS_LIKE_PO.test(m.getSubject() + ' ' + names))) {
        console.log('Skipped (not a PO): ' + m.getSubject() + ' from ' + email)
        continue
      }
      const res = UrlFetchApp.fetch(HUB_URL, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { 'x-hub-key': HUB_KEY },
        payload: JSON.stringify({
          id, threadId: t.getId(), from: email, fromName: from.replace(/<[^>]+>/, '').replace(/"/g, '').trim(),
          subject: m.getSubject(), date: m.getDate().toISOString(), body: m.getPlainBody().slice(0, 20000),
          attachments: files.map((a) => ({ name: a.getName(), mime: a.getContentType(), data: Utilities.base64Encode(a.getBytes()) })),
        }),
      })
      if (res.getResponseCode() === 200) { sent.push(id); found++; console.log('Sent to the Hub: ' + m.getSubject()) }
      else console.log('Hub said ' + res.getResponseCode() + ' for "' + m.getSubject() + '": ' + res.getContentText())
    }
  }
  props.setProperty('sent', JSON.stringify(sent.slice(-500)))
  // Tell the Hub this check ran (shown on "To confirm"), even when there was nothing new.
  UrlFetchApp.fetch(HUB_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { 'x-hub-key': HUB_KEY }, payload: JSON.stringify({ ping: true, found }) })
}

// Run this once: it checks every 15 minutes from then on.
function setUp() {
  for (const t of ScriptApp.getProjectTriggers()) ScriptApp.deleteTrigger(t)
  ScriptApp.newTrigger('sendNewEmails').timeBased().everyMinutes(15).create()
  sendNewEmails()
}
