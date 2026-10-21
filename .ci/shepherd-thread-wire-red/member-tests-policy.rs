use std::io;
use std::sync::Arc;

use cmux_managed_codex_host::policy::check_derived_policy;
use cmux_managed_codex_host::profile::fixed_catalog;
use codex_config::AbsolutePathBuf;
use codex_config::CloudConfigBundleLoader;
use codex_config::Constrained;
use codex_config::LoaderOverrides;
use codex_core::config::Config;
use codex_core::config::ConfigBuilder;
use codex_core::config::ConfigOverrides;
use codex_core::config::ThreadStoreConfig;
use codex_core::config::TokenBudgetConfig;
use codex_features::Feature;
use codex_protocol::config_types::WebSearchMode;
use codex_protocol::openai_models::ModelsResponse;
use codex_protocol::openai_models::ToolMode;
use codex_protocol::protocol::AskForApproval;
use codex_protocol::protocol::MultiAgentVersion;
use tempfile::TempDir;

const STORE_ID: &str = "cmux-00000000-0000-4000-8000-000000000001";
const EXCLUDED: &[Feature] = &[
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

struct Fixture {
    home: TempDir,
}

impl Fixture {
    fn new() -> io::Result<Self> {
        let home = TempDir::new()?;
        let catalog = home.path().join("models.json");
        std::fs::write(&catalog, serde_json::to_vec(&fixed_catalog()?)?)?;
        let mut contents = format!(
            "model = \"gpt-5.5\"\nmodel_provider = \"openai\"\n\
             approval_policy = \"never\"\nweb_search = \"disabled\"\n\
             model_catalog_json = {}\n\
             experimental_thread_store = {{ type = \"in_memory\", id = \"{STORE_ID}\" }}\n\
             [agents]\nenabled = false\n\
             [orchestrator.skills]\nenabled = false\n\
             [orchestrator.mcp]\nenabled = false\n\
             [memories]\ngenerate_memories = false\nuse_memories = false\ndedicated_tools = false\n\
             [features]\n",
            serde_json::to_string(&catalog)?,
        );
        for feature in EXCLUDED {
            contents.push_str(&format!("{} = false\n", feature.key()));
        }
        std::fs::write(home.path().join("config.toml"), contents)?;
        Ok(Self { home })
    }

    async fn load(&self) -> io::Result<Config> {
        ConfigBuilder::default()
            .codex_home(self.home.path().to_path_buf())
            .cli_overrides(vec![(
                "mcp_servers".into(),
                serde_json::from_str("{}")?,
            )])
            .loader_overrides(LoaderOverrides {
                managed_config_path: Some(self.home.path().join("managed.toml")),
                system_config_path: Some(self.home.path().join("system.toml")),
                system_requirements_path: Some(self.home.path().join("requirements.toml")),
                ignore_project_config: true,
                ..LoaderOverrides::without_managed_config_for_tests()
            })
            .harness_overrides(ConfigOverrides {
                cwd: Some(self.home.path().to_path_buf()),
                ephemeral: Some(true),
                ..ConfigOverrides::default()
            })
            .strict_config(true)
            .cloud_config_bundle(CloudConfigBundleLoader::default())
            .thread_config_loader(Arc::new(codex_config::NoopThreadConfigLoader))
            .build()
            .await
    }

    fn check(&self, config: &Config) -> io::Result<()> {
        check_derived_policy(config, self.home.path(), STORE_ID)
    }
}

#[tokio::test]
async fn policy_accepts_actual_builder_positive_control_without_mutation() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let config = fixture.load().await?;
    assert_eq!(config.model.as_deref(), Some("gpt-5.5"));
    assert_eq!(config.model_provider_id, "openai");
    assert_eq!(config.model_catalog, Some(fixed_catalog()?));
    assert_eq!(config.permissions.approval_policy.value(), AskForApproval::Never);
    assert!(config.ephemeral);
    assert!(!config.agents_enabled);
    assert!(config.mcp_servers.get().is_empty());
    assert!(!config.orchestrator_skills_enabled);
    assert!(!config.orchestrator_mcp_enabled);
    assert!(!config.memories.generate_memories);
    for feature in EXCLUDED {
        assert!(!config.features.enabled(*feature), "{}", feature.key());
    }
    for available in [false, true] {
        assert_eq!(
            codex_core::cmux_native_profile_tool_modes(
                &config, &config.model_catalog.as_ref().unwrap().models[0], available,
            ),
            (ToolMode::Direct, ToolMode::Direct),
        );
    }
    let original = config.clone();
    fixture.check(&config)?;
    assert_eq!(original, config);
    Ok(())
}

macro_rules! reject_feature {
    ($name:ident, $feature:expr) => {
        #[tokio::test]
        async fn $name() -> io::Result<()> {
            let fixture = Fixture::new()?;
            let mut config = fixture.load().await?;
            fixture.check(&config)?;
            config.features.set_enabled($feature, true)?;
            assert!(config.features.enabled($feature), "mutation did not take effect");
            let original = config.clone();
            assert!(fixture.check(&config).is_err(), "accepted excluded feature {}", $feature.key());
            assert_eq!(original, config, "validator coerced the derived config");
            Ok(())
        }
    };
}

reject_feature!(policy_rejects_multi_agent_v2, Feature::MultiAgentV2);
reject_feature!(policy_rejects_goals, Feature::Goals);
reject_feature!(policy_rejects_memories, Feature::MemoryTool);
reject_feature!(policy_rejects_guardian_approval, Feature::GuardianApproval);
reject_feature!(policy_rejects_sleep, Feature::SleepTool);
reject_feature!(policy_rejects_code_mode, Feature::CodeMode);
reject_feature!(policy_rejects_code_mode_only, Feature::CodeModeOnly);
reject_feature!(policy_rejects_code_mode_prewarm, Feature::CodeModePrewarm);
reject_feature!(policy_rejects_hooks, Feature::CodexHooks);
reject_feature!(policy_rejects_live_web_feature, Feature::WebSearchRequest);
reject_feature!(policy_rejects_cached_web_feature, Feature::WebSearchCached);
reject_feature!(policy_rejects_image_generation, Feature::ImageGeneration);
reject_feature!(policy_rejects_apps, Feature::Apps);
reject_feature!(policy_rejects_plugins, Feature::Plugins);
reject_feature!(policy_rejects_skill_mcp_install, Feature::SkillMcpDependencyInstall);
reject_feature!(policy_rejects_skill_search, Feature::SkillSearch);

macro_rules! reject_value {
    ($name:ident, $config:ident, $mutate:block, $observed:expr) => {
        #[tokio::test]
        async fn $name() -> io::Result<()> {
            let fixture = Fixture::new()?;
            let mut $config = fixture.load().await?;
            fixture.check(&$config)?;
            $mutate
            assert!($observed, "mutation did not take effect");
            let original = $config.clone();
            assert!(fixture.check(&$config).is_err(), "accepted {}", stringify!($name));
            assert_eq!(original, $config, "validator coerced the derived config");
            Ok(())
        }
    };
}

reject_value!(policy_rejects_agents, c, { c.agents_enabled = true; }, c.agents_enabled);
reject_value!(policy_rejects_persistent_state, c, { c.ephemeral = false; }, !c.ephemeral);
reject_value!(policy_rejects_memory_generation, c, {
    c.memories.generate_memories = true;
}, c.memories.generate_memories);
reject_value!(policy_rejects_memory_use, c, {
    c.memories.use_memories = true;
}, c.memories.use_memories);
reject_value!(policy_rejects_memory_tools, c, {
    c.memories.dedicated_tools = true;
}, c.memories.dedicated_tools);
reject_value!(policy_rejects_legacy_notify, c, {
    c.notify = Some(vec!["/usr/bin/true".into()]);
}, c.notify.as_ref().is_some_and(|v| !v.is_empty()));
reject_value!(policy_rejects_history_notes, c, {
    c.token_budget = Some(TokenBudgetConfig {
        use_history_notes_extension: true,
        ..TokenBudgetConfig::default()
    });
}, c.token_budget.as_ref().is_some_and(|v| v.use_history_notes_extension));
reject_value!(policy_rejects_orchestrator_skills, c, {
    c.orchestrator_skills_enabled = true;
}, c.orchestrator_skills_enabled);
reject_value!(policy_rejects_orchestrator_mcp, c, {
    c.orchestrator_mcp_enabled = true;
}, c.orchestrator_mcp_enabled);
reject_value!(policy_rejects_approval_policy, c, {
    c.permissions.approval_policy = Constrained::allow_any(AskForApproval::OnRequest);
}, c.permissions.approval_policy.value() == AskForApproval::OnRequest);
reject_value!(policy_rejects_live_web_mode, c, {
    c.web_search_mode = Constrained::allow_any(WebSearchMode::Live);
}, c.web_search_mode.value() == WebSearchMode::Live);
reject_value!(policy_rejects_wrong_model, c, {
    c.model = Some("gpt-foreign".into());
}, c.model.as_deref() == Some("gpt-foreign"));
reject_value!(policy_rejects_missing_model, c, { c.model = None; }, c.model.is_none());
reject_value!(policy_rejects_wrong_provider, c, {
    c.model_provider_id = "foreign".into();
}, c.model_provider_id == "foreign");
reject_value!(policy_rejects_provider_redefinition, c, {
    c.model_provider.base_url = Some("https://invalid.example".into());
}, c.model_provider.base_url.as_deref() == Some("https://invalid.example"));
reject_value!(policy_rejects_local_store, c, {
    c.experimental_thread_store = ThreadStoreConfig::Local;
}, c.experimental_thread_store == ThreadStoreConfig::Local);
reject_value!(policy_rejects_foreign_store, c, {
    c.experimental_thread_store = ThreadStoreConfig::InMemory { id: "foreign".into() };
}, matches!(&c.experimental_thread_store, ThreadStoreConfig::InMemory { id } if id == "foreign"));
reject_value!(policy_rejects_missing_catalog, c, {
    c.model_catalog = None;
}, c.model_catalog.is_none());
reject_value!(policy_rejects_empty_catalog, c, {
    c.model_catalog = Some(ModelsResponse::default());
}, c.model_catalog.as_ref().unwrap().models.is_empty());
reject_value!(policy_rejects_extra_catalog_entry, c, {
    let catalog = c.model_catalog.as_mut().unwrap();
    catalog.models.push(catalog.models[0].clone());
}, c.model_catalog.as_ref().unwrap().models.len() == 2);
reject_value!(policy_rejects_async_catalog_tool, c, {
    c.model_catalog.as_mut().unwrap().models[0].experimental_supported_tools.push("sleep".into());
}, !c.model_catalog.as_ref().unwrap().models[0].experimental_supported_tools.is_empty());
reject_value!(policy_rejects_model_delegation, c, {
    c.model_catalog.as_mut().unwrap().models[0].multi_agent_version = Some(MultiAgentVersion::V2);
}, c.model_catalog.as_ref().unwrap().models[0].multi_agent_version == Some(MultiAgentVersion::V2));
reject_value!(policy_rejects_implicit_tool_mode, c, {
    c.model_catalog.as_mut().unwrap().models[0].tool_mode = None;
}, c.model_catalog.as_ref().unwrap().models[0].tool_mode.is_none());
reject_value!(policy_rejects_code_mode_metadata, c, {
    c.model_catalog.as_mut().unwrap().models[0].tool_mode = Some(ToolMode::CodeMode);
}, c.model_catalog.as_ref().unwrap().models[0].tool_mode == Some(ToolMode::CodeMode));
reject_value!(policy_rejects_changed_full_metadata, c, {
    c.model_catalog.as_mut().unwrap().models[0].description = Some("altered".into());
}, c.model_catalog.as_ref().unwrap().models[0].description.as_deref() == Some("altered"));

#[tokio::test]
async fn policy_rejects_foreign_cwd() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let mut config = fixture.load().await?;
    fixture.check(&config)?;
    let foreign = tempfile::tempdir()?;
    config.cwd = AbsolutePathBuf::from_absolute_path(foreign.path())?;
    assert_ne!(config.cwd.as_path(), fixture.home.path());
    assert!(fixture.check(&config).is_err(), "accepted foreign canonical cwd");
    Ok(())
}

#[tokio::test]
async fn policy_rejects_effective_mcp_map_even_with_empty_cli_override() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let path = fixture.home.path().join("config.toml");
    let mut contents = std::fs::read_to_string(&path)?;
    contents.push_str("\n[mcp_servers.fixture]\ncommand = \"/usr/bin/true\"\n");
    std::fs::write(path, contents)?;
    let config = fixture.load().await?;
    assert_eq!(config.mcp_servers.get().len(), 1);
    assert!(fixture.check(&config).is_err(), "accepted configured MCP server without starting it");
    Ok(())
}

#[tokio::test]
async fn policy_rejects_actual_managed_feature_conflict_before_start() -> io::Result<()> {
    let fixture = Fixture::new()?;
    std::fs::write(fixture.home.path().join("managed.toml"), "[features]\ngoals = true\n")?;
    let config = fixture.load().await?;
    assert!(config.features.enabled(Feature::Goals), "managed layer did not win");
    let original = config.clone();
    assert!(fixture.check(&config).is_err(), "accepted managed conflict");
    assert_eq!(original, config);
    Ok(())
}

#[tokio::test]
async fn policy_rejects_actual_managed_catalog_override() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let path = fixture.home.path().join("foreign-models.json");
    let mut foreign = fixed_catalog()?;
    foreign.models[0].description = Some("managed replacement".into());
    std::fs::write(&path, serde_json::to_vec(&foreign)?)?;
    std::fs::write(
        fixture.home.path().join("managed.toml"),
        format!("model_catalog_json = {}\n", serde_json::to_string(&path)?),
    )?;
    let config = fixture.load().await?;
    assert_eq!(config.model_catalog.as_ref(), Some(&foreign));
    assert!(fixture.check(&config).is_err(), "accepted changed complete managed catalog");
    Ok(())
}

#[tokio::test]
async fn policy_rejects_actual_managed_approval_requirements() -> io::Result<()> {
    let fixture = Fixture::new()?;
    std::fs::write(
        fixture.home.path().join("requirements.toml"),
        "allowed_approval_policies = [\"on-request\"]\n",
    )?;
    let config = fixture.load().await?;
    assert_eq!(config.permissions.approval_policy.value(), AskForApproval::OnRequest);
    assert!(fixture.check(&config).is_err(), "accepted normalized managed approval policy");
    Ok(())
}

#[tokio::test]
async fn policy_preserves_requirements_and_full_catalog_after_files_change() -> io::Result<()> {
    let fixture = Fixture::new()?;
    std::fs::write(
        fixture.home.path().join("requirements.toml"),
        "allowed_approval_policies = [\"never\"]\n",
    )?;
    let config = fixture.load().await?;
    let original = config.clone();
    fixture.check(&config)?;
    std::fs::write(fixture.home.path().join("config.toml"), "model = \"foreign\"\n")?;
    std::fs::write(fixture.home.path().join("models.json"), "{}")?;
    std::fs::write(fixture.home.path().join("requirements.toml"), "invalid")?;
    fixture.check(&config)?;
    assert_eq!(config, original);
    assert!(config.permissions.approval_policy.can_set(&AskForApproval::OnRequest).is_err());
    Ok(())
}

#[test]
fn policy_catalog_is_one_complete_compiled_entry_with_exact_direct_mode() -> io::Result<()> {
    let mut original: ModelsResponse = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"), "/../models-manager/models.json"
    )))?;
    original.models.retain(|model| model.slug == "gpt-5.5");
    assert_eq!(original.models.len(), 1);
    original.models[0].experimental_supported_tools.clear();
    original.models[0].multi_agent_version = Some(MultiAgentVersion::Disabled);
    original.models[0].tool_mode = Some(ToolMode::Direct);
    assert_eq!(fixed_catalog()?, original);
    Ok(())
}
