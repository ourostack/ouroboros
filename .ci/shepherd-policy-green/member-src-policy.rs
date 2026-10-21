use std::io;
use std::path::Path;

use codex_core::config::Config;
use codex_core::config::ThreadStoreConfig;
use codex_features::Feature;
use codex_model_provider_info::ModelProviderInfo;
use codex_protocol::config_types::WebSearchMode;
use codex_protocol::openai_models::ToolMode;
use codex_protocol::protocol::AskForApproval;

use crate::profile::fixed_catalog;

const EXCLUDED_FEATURES: &[Feature] = &[
    Feature::MultiAgentV2,
    Feature::Goals,
    Feature::MemoryTool,
    Feature::GuardianApproval,
    Feature::SleepTool,
    Feature::CodeMode,
    Feature::CodeModeOnly,
    Feature::CodeModePrewarm,
    Feature::CodexHooks,
    Feature::WebSearchRequest,
    Feature::WebSearchCached,
    Feature::ImageGeneration,
    Feature::Apps,
    Feature::Plugins,
    Feature::SkillMcpDependencyInstall,
    Feature::SkillSearch,
];

fn require(condition: bool, field: &'static str) -> io::Result<()> {
    if condition {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("native profile conflict: {field}"),
        ))
    }
}

/// Validate actual derived values without changing policy, provenance or loaded strings.
/// Successful validation alone is not a startup capability.
pub fn check_derived_policy(config: &Config, cwd: &Path, store_id: &str) -> io::Result<()> {
    require(cwd.is_absolute() && config.cwd.as_path() == cwd, "cwd")?;
    require(
        !store_id.is_empty()
            && matches!(
                &config.experimental_thread_store,
                ThreadStoreConfig::InMemory { id } if id == store_id
            ),
        "thread_store",
    )?;
    require(config.ephemeral, "ephemeral")?;
    require(config.model.as_deref() == Some("gpt-5.5"), "model")?;
    require(
        config.model_provider_id == "openai"
            && config.model_provider == ModelProviderInfo::create_openai_provider(None),
        "model_provider",
    )?;
    let expected = fixed_catalog()?;
    require(config.model_catalog.as_ref() == Some(&expected), "model_catalog")?;
    let model = config.model_catalog.as_ref().and_then(|catalog| catalog.models.first())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "native profile conflict: model_catalog")
        })?;
    for available in [false, true] {
        require(
            codex_core::cmux_native_profile_tool_modes(config, model, available)
                == (ToolMode::Direct, ToolMode::Direct),
            "derived_tool_mode",
        )?;
    }
    require(!config.agents_enabled, "agents")?;
    for feature in EXCLUDED_FEATURES {
        require(!config.features.enabled(*feature), feature.key())?;
    }
    require(
        config.permissions.approval_policy.value() == AskForApproval::Never,
        "approval_policy",
    )?;
    require(config.web_search_mode.value() == WebSearchMode::Disabled, "web_search")?;
    require(config.mcp_servers.get().is_empty(), "mcp_servers")?;
    require(!config.orchestrator_skills_enabled, "orchestrator_skills")?;
    require(!config.orchestrator_mcp_enabled, "orchestrator_mcp")?;
    require(
        config.notify.as_ref().is_none_or(Vec::is_empty),
        "legacy_notify",
    )?;
    require(
        config.token_budget.as_ref().is_none_or(|budget| !budget.use_history_notes_extension),
        "history_notes",
    )?;
    require(!config.memories.generate_memories, "generate_memories")?;
    require(!config.memories.use_memories, "use_memories")?;
    require(!config.memories.dedicated_tools, "memory_tools")?;
    Ok(())
}
