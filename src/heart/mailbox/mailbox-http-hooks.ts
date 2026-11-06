import * as path from "path"
import {
  readAttentionView,
  readBridgeInventory,
  readChangesView,
  readCodingDeep,
  readDaemonHealthDeep,
  readDeskPrefs,
  readFriendView,
  readHabitView,
  readLogView,
  readMailMessageView,
  readMailView,
  readNoteDecisionView,
  readNotesView,
  readNeedsMeView,
  readObligationDetailView,
  readOrientationView,
  readMailboxContinuity,
  readSelfFixView,
  readSessionInventory,
  readSessionTranscript,
} from "./mailbox-read"
import type {
  MailboxAttentionView,
  MailboxBridgeInventory,
  MailboxChangesView,
  MailboxCodingDeep,
  MailboxContinuityView,
  MailboxDaemonHealthDeep,
  MailboxDeskPrefs,
  MailboxFriendView,
  MailboxHabitView,
  MailboxLogView,
  MailboxMailMessageView,
  MailboxMailView,
  MailboxNoteDecisionView,
  MailboxNotesView,
  MailboxNeedsMeView,
  MailboxObligationDetailView,
  MailboxOrientationView,
  MailboxSelfFixView,
  MailboxSessionInventory,
  MailboxSessionTranscript,
} from "./mailbox-types"

export interface MailboxHttpReadHookOptions {
  bundlesRoot?: string
  healthPath?: string
  logPath?: string | null
  readAgentSessions?: (agentName: string) => MailboxSessionInventory
  readAgentTranscript?: (agentName: string, friendId: string, channel: string, key: string) => MailboxSessionTranscript | null
  readAgentCoding?: (agentName: string) => MailboxCodingDeep
  readAgentAttention?: (agentName: string) => MailboxAttentionView
  readAgentBridges?: (agentName: string) => MailboxBridgeInventory
  readAgentNotes?: (agentName: string) => MailboxNotesView
  readAgentFriends?: (agentName: string) => MailboxFriendView
  readAgentContinuity?: (agentName: string) => MailboxContinuityView
  readAgentOrientation?: (agentName: string) => MailboxOrientationView
  readAgentObligations?: (agentName: string) => MailboxObligationDetailView
  readAgentChanges?: (agentName: string) => MailboxChangesView
  readAgentSelfFix?: (agentName: string) => MailboxSelfFixView
  readAgentNoteDecisions?: (agentName: string) => MailboxNoteDecisionView
  readAgentHabits?: (agentName: string) => MailboxHabitView
  readAgentMail?: (agentName: string) => Promise<MailboxMailView> | MailboxMailView
  readAgentMailMessage?: (agentName: string, messageId: string) => Promise<MailboxMailMessageView> | MailboxMailMessageView
  readDaemonHealth?: () => MailboxDaemonHealthDeep | null
  readLogs?: () => MailboxLogView
}

export interface MailboxHttpReadHooks {
  agentRoot(agentName: string): string
  readAgentSessions(agentName: string): MailboxSessionInventory
  readAgentTranscript(agentName: string, friendId: string, channel: string, key: string): MailboxSessionTranscript | null
  readAgentCoding(agentName: string): MailboxCodingDeep
  readAgentAttention(agentName: string): MailboxAttentionView
  readAgentBridges(agentName: string): MailboxBridgeInventory
  readAgentNotes(agentName: string): MailboxNotesView
  readAgentFriends(agentName: string): MailboxFriendView
  readAgentContinuity(agentName: string): MailboxContinuityView
  readAgentOrientation(agentName: string): MailboxOrientationView
  readAgentObligations(agentName: string): MailboxObligationDetailView
  readAgentChanges(agentName: string): MailboxChangesView
  readAgentSelfFix(agentName: string): MailboxSelfFixView
  readAgentNoteDecisions(agentName: string): MailboxNoteDecisionView
  readAgentHabits(agentName: string): MailboxHabitView
  readAgentMail(agentName: string): Promise<MailboxMailView> | MailboxMailView
  readAgentMailMessage(agentName: string, messageId: string): Promise<MailboxMailMessageView> | MailboxMailMessageView
  readDaemonHealth(): MailboxDaemonHealthDeep | null
  readLogs(): MailboxLogView
  readDeskPrefs(agentName: string): MailboxDeskPrefs
  readNeedsMe(agentName: string): MailboxNeedsMeView
}

export function createMailboxHttpReadHooks(options: MailboxHttpReadHookOptions): MailboxHttpReadHooks {
  const bundlesRoot = options.bundlesRoot
  const readOptions = bundlesRoot ? { bundlesRoot } : undefined
  const agentRoot = (agentName: string) => path.join(bundlesRoot ?? "", `${agentName}.ouro`)

  return {
    agentRoot,
    readAgentSessions: options.readAgentSessions ?? ((agentName: string) => readSessionInventory(agentName, readOptions)),
    readAgentTranscript: options.readAgentTranscript ?? ((agentName: string, friendId: string, channel: string, key: string) => readSessionTranscript(agentName, friendId, channel, key, readOptions)),
    readAgentCoding: options.readAgentCoding ?? ((agentName: string) => readCodingDeep(agentRoot(agentName))),
    readAgentAttention: options.readAgentAttention ?? ((agentName: string) => readAttentionView(agentName, readOptions)),
    readAgentBridges: options.readAgentBridges ?? ((agentName: string) => readBridgeInventory(agentRoot(agentName))),
    readAgentNotes: options.readAgentNotes ?? ((agentName: string) => readNotesView(agentRoot(agentName))),
    readAgentFriends: options.readAgentFriends ?? ((agentName: string) => readFriendView(agentName, readOptions)),
    readAgentContinuity: options.readAgentContinuity ?? ((agentName: string) => readMailboxContinuity(agentRoot(agentName), agentName)),
    readAgentOrientation: options.readAgentOrientation ?? ((agentName: string) => readOrientationView(agentRoot(agentName), agentName)),
    readAgentObligations: options.readAgentObligations ?? ((agentName: string) => readObligationDetailView(agentRoot(agentName))),
    readAgentChanges: options.readAgentChanges ?? ((agentName: string) => readChangesView(agentRoot(agentName))),
    readAgentSelfFix: options.readAgentSelfFix ?? ((agentName: string) => readSelfFixView(agentRoot(agentName))),
    readAgentNoteDecisions: options.readAgentNoteDecisions ?? ((agentName: string) => readNoteDecisionView(agentRoot(agentName))),
    readAgentHabits: options.readAgentHabits ?? ((agentName: string) => readHabitView(agentRoot(agentName))),
    readAgentMail: options.readAgentMail ?? ((agentName: string) => readMailView(agentName)),
    readAgentMailMessage: options.readAgentMailMessage ?? ((agentName: string, messageId: string) => readMailMessageView(agentName, messageId)),
    readDaemonHealth: options.readDaemonHealth ?? (() => readDaemonHealthDeep(options.healthPath)),
    readLogs: options.readLogs ?? (() => readLogView(options.logPath ?? null)),
    readDeskPrefs: (agentName: string) => readDeskPrefs(agentRoot(agentName)),
    readNeedsMe: (agentName: string) => readNeedsMeView(agentName, readOptions),
  }
}
