use std::io;

use codex_app_server_protocol::ThreadStartParams;
use codex_app_server_protocol::TurnStartParams;
use codex_app_server_protocol::UserInput;
use codex_core::config::Config;
use codex_core::config::ThreadStoreConfig;
use codex_protocol::dynamic_tools::DynamicToolFunctionSpec;
use codex_protocol::dynamic_tools::DynamicToolSpec;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use crate::policy::EXCLUDED_FEATURES;
use crate::profile::fixed_catalog;

const INTEGRATION_PATCH_SHA256: &str =
    "65358970299e3b3cb32890cd7bca1c1962c4f3bfcbaa2a31dcc69fcab8bce6a6";

pub(crate) fn json_sha(value: &Value) -> io::Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

pub fn describe_profile() -> io::Result<Value> {
    let tool = serde_json::to_value(native_tool()?)?;
    let mut turn_options = serde_json::to_value(fixed_turn_params(
        "descriptor-thread".into(), "descriptor-input".into(),
    )?)?;
    let object = turn_options.as_object_mut()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "typed turn was not an object"))?;
    object.remove("threadId");
    object.remove("input");
    Ok(json!({
        "profileId": "codex-0.154-frozen-native-foreground-v1",
        "privateBridgeVersion": 1,
        "upstreamCommit": "6b9826e3aa83b1a5947db50f4332cb9c65f1b340",
        "integrationPatchSha256": INTEGRATION_PATCH_SHA256,
        "catalogSha256": json_sha(&serde_json::to_value(fixed_catalog()?)?)?,
        "commandSchemaSha256": json_sha(&tool["inputSchema"])?,
        "nativeTool": tool,
        "threadOptions": fixed_thread_params()?,
        "turnOptions": turn_options,
        "commandAuthority": {
            "execution": "general-purpose-foreground",
            "authority": "native-user-project",
            "sdkApprovalPrompt": false,
            "sdkSandbox": false,
            "activation": "fresh-native-panel-opt-in",
            "rpcActivationAllowed": false,
        },
    }))
}

pub(crate) fn native_tool() -> io::Result<DynamicToolSpec> {
    Ok(DynamicToolSpec::Function(DynamicToolFunctionSpec {
        name: "cmux_run_foreground".into(),
        description: "Run one foreground command with the native project authority. No terminal, background work, stdin, directory, environment or timeout overrides.".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "program": {"type": "string"},
                "arguments": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["program", "arguments"],
            "additionalProperties": false,
        }),
        defer_loading: false,
    }))
}

pub(crate) fn fixed_thread_params() -> io::Result<ThreadStartParams> {
    Ok(codex_app_server::in_process::frozen_thread_start_params(vec![native_tool()?]))
}

pub(crate) fn fixed_turn_params(thread_id: String, text: String) -> io::Result<TurnStartParams> {
    if thread_id.is_empty() || thread_id.len() > 128 || text.trim().is_empty() || text.len() > 65_536 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "text turn exceeds the native profile"));
    }
    Ok(TurnStartParams {
        thread_id,
        input: vec![UserInput::Text { text, text_elements: Vec::new() }],
        client_user_message_id: None,
        turn_trigger: None,
        tool_output: None,
        responsesapi_client_metadata: None,
        additional_context: None,
        environments: Some(Vec::new()),
        cwd: None,
        runtime_workspace_roots: None,
        approval_policy: None,
        approvals_reviewer: None,
        sandbox_policy: None,
        permissions: None,
        model: None,
        service_tier: None,
        service_tier_for_turn: None,
        effort: None,
        summary: None,
        personality: None,
        output_schema: None,
        collaboration_mode: None,
        multi_agent_mode: None,
        cyber_access_program: None,
    })
}

pub(crate) fn effective_policy(config: &Config) -> io::Result<Value> {
    let model = config.model_catalog.as_ref().and_then(|catalog| catalog.models.first())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "sealed catalog missing"))?;
    let ThreadStoreConfig::InMemory { id } = &config.experimental_thread_store else {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "sealed memory store missing"));
    };
    let tool_modes_by_availability = [false, true].map(|available| {
        codex_core::cmux_native_profile_tool_modes(config, model, available)
    });
    let features = EXCLUDED_FEATURES.iter()
        .map(|feature| (feature.key().to_string(), json!(config.features.enabled(*feature))))
        .collect::<serde_json::Map<String, Value>>();
    Ok(json!({
        "model": config.model,
        "modelProviderId": config.model_provider_id,
        "ephemeral": config.ephemeral,
        "agentsEnabled": config.agents_enabled,
        "approvalPolicy": config.permissions.approval_policy.value(),
        "webSearch": config.web_search_mode.value(),
        "features": features,
        "toolModesByAvailability": tool_modes_by_availability,
        "catalogSha256": json_sha(&serde_json::to_value(&config.model_catalog)?)?,
        "modelExperimentalTools": model.experimental_supported_tools,
        "modelMultiAgentVersion": model.multi_agent_version,
        "mcpServerCount": config.mcp_servers.get().len(),
        "legacyNotifyCount": config.notify.as_ref().map_or(0, Vec::len),
        "orchestratorSkillsEnabled": config.orchestrator_skills_enabled,
        "orchestratorMcpEnabled": config.orchestrator_mcp_enabled,
        "generateMemories": config.memories.generate_memories,
        "useMemories": config.memories.use_memories,
        "dedicatedMemoryTools": config.memories.dedicated_tools,
        "historyNotes": config.token_budget.as_ref().is_some_and(|budget| budget.use_history_notes_extension),
        "threadStore": {"type": "inMemory", "id": id},
    }))
}
