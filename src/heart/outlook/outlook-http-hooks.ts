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
  readOutlookContinuity,
  readSelfFixView,
  readSessionInventory,
  readSessionTranscript,
} from "./outlook-read"
import type {
  OutlookAttentionView,
  OutlookBridgeInventory,
  OutlookChangesView,
  OutlookCodingDeep,
  OutlookContinuityView,
  OutlookDaemonHealthDeep,
  OutlookDeskPrefs,
  OutlookFriendView,
  OutlookHabitView,
  OutlookLogView,
  OutlookMailMessageView,
  OutlookMailView,
  OutlookNoteDecisionView,
  OutlookNotesView,
  OutlookNeedsMeView,
  OutlookObligationDetailView,
  OutlookOrientationView,
  OutlookSelfFixView,
  OutlookSessionInventory,
  OutlookSessionTranscript,
} from "./outlook-types"

export interface OutlookHttpReadHookOptions {
  bundlesRoot?: string
  healthPath?: string
  logPath?: string | null
  readAgentSessions?: (agentName: string) => OutlookSessionInventory
  readAgentTranscript?: (agentName: string, friendId: string, channel: string, key: string) => OutlookSessionTranscript | null
  readAgentCoding?: (agentName: string) => OutlookCodingDeep
  readAgentAttention?: (agentName: string) => OutlookAttentionView
  readAgentBridges?: (agentName: string) => OutlookBridgeInventory
  readAgentNotes?: (agentName: string) => OutlookNotesView
  readAgentFriends?: (agentName: string) => OutlookFriendView
  readAgentContinuity?: (agentName: string) => OutlookContinuityView
  readAgentOrientation?: (agentName: string) => OutlookOrientationView
  readAgentObligations?: (agentName: string) => OutlookObligationDetailView
  readAgentChanges?: (agentName: string) => OutlookChangesView
  readAgentSelfFix?: (agentName: string) => OutlookSelfFixView
  readAgentNoteDecisions?: (agentName: string) => OutlookNoteDecisionView
  readAgentHabits?: (agentName: string) => OutlookHabitView
  readAgentMail?: (agentName: string) => Promise<OutlookMailView> | OutlookMailView
  readAgentMailMessage?: (agentName: string, messageId: string) => Promise<OutlookMailMessageView> | OutlookMailMessageView
  readDaemonHealth?: () => OutlookDaemonHealthDeep | null
  readLogs?: () => OutlookLogView
}

export interface OutlookHttpReadHooks {
  agentRoot(agentName: string): string
  readAgentSessions(agentName: string): OutlookSessionInventory
  readAgentTranscript(agentName: string, friendId: string, channel: string, key: string): OutlookSessionTranscript | null
  readAgentCoding(agentName: string): OutlookCodingDeep
  readAgentAttention(agentName: string): OutlookAttentionView
  readAgentBridges(agentName: string): OutlookBridgeInventory
  readAgentNotes(agentName: string): OutlookNotesView
  readAgentFriends(agentName: string): OutlookFriendView
  readAgentContinuity(agentName: string): OutlookContinuityView
  readAgentOrientation(agentName: string): OutlookOrientationView
  readAgentObligations(agentName: string): OutlookObligationDetailView
  readAgentChanges(agentName: string): OutlookChangesView
  readAgentSelfFix(agentName: string): OutlookSelfFixView
  readAgentNoteDecisions(agentName: string): OutlookNoteDecisionView
  readAgentHabits(agentName: string): OutlookHabitView
  readAgentMail(agentName: string): Promise<OutlookMailView> | OutlookMailView
  readAgentMailMessage(agentName: string, messageId: string): Promise<OutlookMailMessageView> | OutlookMailMessageView
  readDaemonHealth(): OutlookDaemonHealthDeep | null
  readLogs(): OutlookLogView
  readDeskPrefs(agentName: string): OutlookDeskPrefs
  readNeedsMe(agentName: string): OutlookNeedsMeView
}

export function createOutlookHttpReadHooks(options: OutlookHttpReadHookOptions): OutlookHttpReadHooks {
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
    readAgentContinuity: options.readAgentContinuity ?? ((agentName: string) => readOutlookContinuity(agentRoot(agentName), agentName)),
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
