import type { AgentId } from '../databus.js'

export type MailItem = {
  id: string
  from: AgentId
  to: AgentId
  subject: string
  body: string
  // v0.12.1: sender-provided short overview (truncated to MAX_SUMMARY_LENGTH
  // in deliver) so recipients can triage mail without reading the full body.
  summary?: string
  replyTo?: string
  sentAt: number
  read: boolean
  // v0.12.1: read receipt — stamped by markRead so the SENDER can query
  // whether (and when) their mail was read via sentStatus/mailbox_status.
  readAt?: number
}
