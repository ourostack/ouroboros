import type { HabitFile } from "../../../heart/habits/habit-parser"

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false
type Assert<Condition extends true> = Condition
type IsNever<Value> = [Value] extends [never] ? true : false

type ExpectedHabitFileStatus = "active" | "paused" | "cancelled" | "degraded"
type ExpectedHabitDegradedReason =
  | "unterminated_frontmatter"
  | "malformed_frontmatter"
  | "invalid_status"
  | "invalid_metadata"
  | "read_error"
type DegradedHabitFile = Extract<HabitFile, { status: "degraded" }>
type ActiveHabitFile = Extract<HabitFile, { status: "active" }>

export type HabitStatusIsExact = Assert<Equal<HabitFile["status"], ExpectedHabitFileStatus>>
export type DegradedVariantExists = Assert<Equal<IsNever<DegradedHabitFile>, false>>
export type DegradedReasonIsExact = Assert<Equal<DegradedHabitFile["degradedReason"], ExpectedHabitDegradedReason>>
export type DegradedDetailIsExact = Assert<Equal<DegradedHabitFile["degradedDetail"], string | null>>
export type ActiveVariantHasNoDegradedReason = Assert<Equal<Extract<keyof ActiveHabitFile, "degradedReason">, never>>
export type ActiveVariantHasNoDegradedDetail = Assert<Equal<Extract<keyof ActiveHabitFile, "degradedDetail">, never>>
