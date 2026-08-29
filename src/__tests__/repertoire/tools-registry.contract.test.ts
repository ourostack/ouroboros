import { describe, it, expect } from "vitest";
import { baseToolDefinitions } from "../../repertoire/tools-base";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDuplicateCounts(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return new Map([...counts.entries()].filter(([, c]) => c > 1));
}

describe("tool registry contract", () => {
  it("tool names are non-empty and unique", () => {
    const names = baseToolDefinitions.map((d) => d.tool.function.name);

    const empty = names.filter((n) => typeof n !== "string" || n.trim().length === 0);
    expect(empty, `Tool names must be non-empty strings`).toEqual([]);

    const dupes = getDuplicateCounts(names);
    if (dupes.size > 0) {
      const report = [...dupes.entries()].map(([name, count]) => `${name} (${count})`).join(", ");
      throw new Error(`Duplicate tool names found: ${report}`);
    }
  });

  it("tool schema is sane", () => {
    const errors: string[] = [];

    for (const def of baseToolDefinitions) {
      const name = def.tool.function?.name;
      const tool = def.tool as any;

      if (tool.type !== "function") errors.push(`${name}: tool.type must be 'function'`);

      const description = tool.function?.description;
      if (typeof description !== "string" || description.trim().length === 0) {
        errors.push(`${name}: function.description must be a non-empty string`);
      }

      const parameters = tool.function?.parameters;
      if (!isPlainObject(parameters)) {
        errors.push(`${name}: function.parameters must be a non-null object`);
      } else {
        const pType = (parameters as any).type;
        if (pType === "object") {
          const props = (parameters as any).properties;
          if (!isPlainObject(props)) errors.push(`${name}: parameters.properties must be a plain object when type==='object'`);
        }

        const required = (parameters as any).required;
        if (required !== undefined) {
          if (!Array.isArray(required) || required.some((r: unknown) => typeof r !== "string")) {
            errors.push(`${name}: parameters.required must be an array of strings when present`);
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Tool schema contract violations:\n- ${errors.join("\n- ")}`);
    }
  });

  it("every tool definition has a handler function", () => {
    for (const def of baseToolDefinitions) {
      const name = def.tool.function.name;
      expect(typeof def.handler, `tool '${name}' is missing a handler`).toBe("function");
    }
  });

  it("tool surface area snapshot", () => {
    const names = baseToolDefinitions.map((d) => d.tool.function.name).slice().sort();
    expect(names).toMatchSnapshot();
  });

  it("final tool list after H-section audit (H10 contract)", () => {
    const names = baseToolDefinitions.map((d) => d.tool.function.name).slice().sort();

    // Removed in H1: git_commit, gh_cli, get_current_time, list_directory
    expect(names).not.toContain("git_commit");
    expect(names).not.toContain("gh_cli");
    expect(names).not.toContain("get_current_time");
    expect(names).not.toContain("list_directory");

    // Removed in H6: 7 task tools
    expect(names).not.toContain("task_board");
    expect(names).not.toContain("task_create");
    expect(names).not.toContain("task_update_status");
    expect(names).not.toContain("task_board_status");
    expect(names).not.toContain("task_board_action");
    expect(names).not.toContain("task_board_deps");
    expect(names).not.toContain("task_board_sessions");

    // Removed in H7: schedule_reminder
    expect(names).not.toContain("schedule_reminder");

    // Added in H2: edit_file
    expect(names).toContain("edit_file");

    // Added in H3: glob
    expect(names).toContain("glob");

    // Added in H4: grep
    expect(names).toContain("grep");

    // Surviving tools from before H-section
    expect(names).toContain("shell");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("send_message");
    expect(names).toContain("bridge_manage");
    expect(names).toContain("query_active_work");
    expect(names).toContain("query_session");
    expect(names).toContain("web_search");
    expect(names).toContain("diary_write");
    expect(names).toContain("search_facts");
    expect(names).toContain("note");
    expect(names).toContain("consult_diary");
    expect(names).toContain("consult_notes");
    expect(names).toContain("save_friend_note");
    expect(names).toContain("get_friend_note");
    expect(names).toContain("friend_list");
    expect(names).toContain("list_skills");
    expect(names).toContain("load_skill");
    expect(names).toContain("list_recent_attachments");
    expect(names).toContain("materialize_attachment");
    expect(names).toContain("describe_image");
    expect(names).toContain("mail_recent");
    expect(names).toContain("mail_search");
    expect(names).toContain("mail_body");
    expect(names).toContain("mail_thread");
    expect(names).toContain("mail_screener");
    expect(names).toContain("mail_decide");
    expect(names).toContain("mail_status");
    expect(names).toContain("mail_compose");
    expect(names).toContain("mail_send");
    expect(names).toContain("mail_outbox");
    expect(names).toContain("mail_access_log");
    expect(names).toContain("mail_index_refresh");
    expect(names).toContain("claude");
    expect(names).toContain("coding_spawn");
    expect(names).toContain("coding_status");
    expect(names).toContain("coding_tail");
    expect(names).toContain("coding_send_input");
    expect(names).toContain("coding_kill");
    expect(names).toContain("set_reasoning_effort");

    // Added in Phase 3: shell background mode tools
    expect(names).toContain("shell_status");
    expect(names).toContain("shell_tail");

    // Added in continuity substrate: 8 tools
    expect(names).toContain("query_episodes");
    expect(names).toContain("capture_episode");
    expect(names).toContain("query_presence");
    expect(names).toContain("query_cares");
    expect(names).toContain("care_manage");
    expect(names).toContain("query_relationships");
    expect(names).toContain("intention_capture");
    expect(names).toContain("intention_manage");

    // Added in capability discovery: 2 tools
    expect(names).toContain("read_config");
    expect(names).toContain("update_config");

    // Added in credential access layer: 4 credential tools (replaced 5 vault tools)
    expect(names).toContain("credential_get");
    expect(names).toContain("credential_generate_password");
    expect(names).toContain("credential_store");
    expect(names).toContain("credential_list");
    expect(names).toContain("credential_delete");

    // Added in travel agent infrastructure: 3 travel tools
    expect(names).toContain("weather_lookup");
    expect(names).toContain("travel_advisory");
    expect(names).toContain("geocode_search");

    // Added in vault integration: 1 vault tool
    expect(names).toContain("vault_setup");

    // Added in commerce infrastructure: 3 user profile tools
    expect(names).toContain("user_profile_store");
    expect(names).toContain("user_profile_get");
    expect(names).toContain("user_profile_delete");

    // Added in commerce infrastructure: 3 Stripe Issuing tools
    expect(names).toContain("stripe_create_card");
    expect(names).toContain("stripe_deactivate_card");
    expect(names).toContain("stripe_list_cards");

    // Added in commerce infrastructure: 4 Duffel flight tools
    expect(names).toContain("flight_search");
    expect(names).toContain("flight_hold");
    expect(names).toContain("flight_book");
    expect(names).toContain("flight_cancel");

    // Added in trip ledger Step 4 plus preview-gated write hardening.
    expect(names).toContain("trip_ensure_ledger");
    expect(names).toContain("trip_status");
    expect(names).toContain("trip_get");
    expect(names).toContain("trip_replace_preview");
    expect(names).toContain("trip_upsert");
    expect(names).toContain("trip_attach_evidence");
    expect(names).toContain("trip_update_leg_preview");
    expect(names).toContain("trip_update_leg");
    expect(names).toContain("trip_remove_leg_preview");
    expect(names).toContain("trip_remove_leg");
    expect(names).toContain("trip_calendar");
    expect(names).toContain("trip_new_id");

    expect(names).toContain("mail_outbox");
    expect(names).toContain("friend_list");
    expect(names).toContain("await_condition");
    expect(names).toContain("resolve_await");
    expect(names).toContain("cancel_await");

    // Added in let_go primitive: 1 obligation-release tool
    expect(names).toContain("let_go");

    // Added in evolution loop foundation: 8 local case/trace tools
    expect(names).toContain("evolution_status");
    expect(names).toContain("evolution_case");
    expect(names).toContain("evolution_capture");
    expect(names).toContain("evolution_decide");
    expect(names).toContain("evolution_verify");
    expect(names).toContain("evolution_deliver");
    expect(names).toContain("evolution_ratify");
    expect(names).toContain("evolution_close");

    // Added in agent self-maintenance: 2 runtime tools
    expect(names).toContain("restart_runtime");
    expect(names).toContain("revive_sense");

    // Added in orientation substrate: 1 turn-frame inspection tool
    expect(names).toContain("orientation_get");

    // Added in habit session continuity: 1 read-only session summary tool
    expect(names).toContain("session_summary");

    // Added in native RSVP habit work: 2 read-only RSVP snapshot tools
    expect(names).toContain("rsvp_query");
    expect(names).toContain("rsvp_summary");

    // Added in A2A + commerce substrate: 3 A2A tools and 4 commerce authority tools
    expect(names).toContain("a2a_list_peers");
    expect(names).toContain("a2a_send_message");
    expect(names).toContain("a2a_get_task");
    expect(names).toContain("commerce_checkout_preview");
    expect(names).toContain("commerce_checkout_commit");
    expect(names).toContain("commerce_receipt_get");
    expect(names).toContain("commerce_access_log");

    // Added in friends-A2A connect+delegation: connect_to + coordinate + list_delegations + send_result
    expect(names).toContain("connect_to");
    expect(names).toContain("coordinate");
    expect(names).toContain("list_delegations");
    expect(names).toContain("send_result");

    // Exact count: 117 tools
    expect(names).toHaveLength(117);
  });
});
