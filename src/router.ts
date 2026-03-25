// Message router — formats messages, checks triggers, routes outbound
import { Channel, NewMessage } from './types.js'

export function escapeXml(s: string): string {
  if (!s) return ''
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(m.timestamp)}">${escapeXml(m.content)}</message>`
  })
  return `<messages>\n${lines.join('\n')}\n</messages>`
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim()
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText)
  if (!text) return ''
  return text
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected())
  if (!channel) throw new Error(`No channel for JID: ${jid}`)
  return channel.sendMessage(jid, text)
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid))
}

/**
 * Check if any message in the batch contains the trigger word.
 */
export function checkTrigger(messages: NewMessage[], trigger: string): boolean {
  const pattern = new RegExp(
    `(^|\\s)@?${escapeRegex(trigger)}(\\s|$|[,:!?])`,
    'i',
  )
  return messages.some((m) => pattern.test(m.content.trim()))
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
