import { emitNervesEvent } from "../nerves/runtime"

const TOP_UP_LINK = "https://www.astraweb.com/login"
const SAFE_FALLBACK = `Downloads are paused to protect your prepaid credit. Top it up here: ${TOP_UP_LINK}. Tell me when you’re done, and I’ll resume downloads and verify one finishes. Or tell me a reminder time, like “tomorrow at 9.”`
const FORBIDDEN_INTERNALS = /\b(?:SABnzbd|Sonarr|Radarr|Deluge|auth[ -]?check|credential|dead[ -]?letter|indexer has been disabled|keep watching)\b/iu
const EXHAUSTED_CREDIT = /(?:\b(?:prepaid )?credit (?:is |appear(?:s|ed)? |seems? )?(?:exhausted|depleted)\b|\bout of (?:prepaid )?credit\b|\bzero (?:prepaid )?credit\b|\bno (?:prepaid )?credit (?:left|remaining|available)\b)/iu
const REQUIRED_HOUSEHOLD_CONTRACT = [
  /\bdownloads?\b/iu,
  /\bpaused?\b/iu,
  /\bprotect\b/iu,
  /\bprepaid credit\b/iu,
  /\btell me\b/iu,
  /\bdone\b/iu,
  /\bresume\b/iu,
  /\bverify\b/iu,
  /\b(?:finish(?:es|ed)?|completed?)\b/iu,
  /\bremind(?:er)?\b/iu,
  /\btime\b|\btomorrow at 9\b/iu,
]

export function presentSanctuaryDownloadCreditReply(agentName: string, exactQuestion: boolean, text: string): string {
  if (agentName !== "sanctuary" || !exactQuestion || !text.includes(TOP_UP_LINK) || !/\bcredit\b/iu.test(text)) return text
  if (!FORBIDDEN_INTERNALS.test(text) && REQUIRED_HOUSEHOLD_CONTRACT.every((pattern) => pattern.test(text))) return text
  if (!EXHAUSTED_CREDIT.test(text)) return text
  emitNervesEvent({ component: "senses", event: "senses.telegram_download_credit_reply_repaired", message: "repaired Sanctuary download-credit reply at the Telegram boundary", meta: { agentName } })
  return SAFE_FALLBACK
}
