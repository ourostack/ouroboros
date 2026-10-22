use crate::descriptor::{describe_profile, fixed_thread_params, fixed_turn_params, native_tool};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn descriptor_sha(value: &Value) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(value).expect("fixture JSON")))
}

fn expected_native_tool() -> Value {
    json!({
        "type": "function",
        "name": "cmux_run_foreground",
        "description": "Run one foreground command with the native project authority. No terminal, background work, stdin, directory, environment or timeout overrides.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "program": {"type": "string"},
                "arguments": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["program", "arguments"],
            "additionalProperties": false,
        },
    })
}

#[test]
fn cmux_descriptor_native_tool_matches_existing_native_registry() {
    let tool = native_tool().expect("must construct the actual pinned native tool type");
    assert_eq!(serde_json::to_value(tool).expect("typed tool JSON"), expected_native_tool());
}

#[test]
fn cmux_descriptor_thread_options_are_typed_and_have_no_semantic_overrides() {
    let params = fixed_thread_params().expect("must construct fixed typed thread options");
    assert_eq!(params.environments, Some(Vec::new()));
    assert_eq!(params.selected_capability_roots, Some(Vec::new()));
    assert!(!params.allow_provider_model_fallback);
    let mut actual = serde_json::to_value(params).expect("typed thread JSON");
    assert_eq!(actual["dynamicTools"], json!([expected_native_tool()]));
    for key in ["environments", "selectedCapabilityRoots", "dynamicTools"] {
        actual.as_object_mut().expect("thread object").remove(key);
    }
    assert!(actual.as_object().expect("thread object").values().all(Value::is_null),
        "thread constructor supplied a semantic override: {actual}");
}

#[test]
fn cmux_descriptor_turn_options_preserve_literal_and_disable_environments() {
    let literal = " \t@agent\n\"quoted\" \\slash \r\n\u{1f9ed}\0 ";
    let params = fixed_turn_params("sdk-actual-thread".into(), literal.into())
        .expect("must construct fixed typed text turn");
    assert_eq!(params.environments, Some(Vec::new()));
    let mut actual = serde_json::to_value(params).expect("typed turn JSON");
    assert_eq!(actual["threadId"], "sdk-actual-thread");
    assert_eq!(actual["input"], json!([{"type":"text","text":literal,"text_elements":[]}]));
    for key in ["threadId", "input", "environments"] {
        actual.as_object_mut().expect("turn object").remove(key);
    }
    assert!(actual.as_object().expect("turn object").values().all(Value::is_null),
        "turn constructor supplied a semantic override: {actual}");
}

#[test]
fn cmux_descriptor_static_manifest_binds_exact_source_catalog_schema_and_options() {
    let manifest = describe_profile().expect("must produce static manifest");
    assert_eq!(manifest.as_object().expect("manifest object").keys().cloned().collect::<Vec<_>>(),
        ["catalogSha256", "commandAuthority", "commandSchemaSha256", "integrationPatchSha256",
         "nativeTool", "privateBridgeVersion", "profileId", "threadOptions", "turnOptions",
         "upstreamCommit"]);
    assert_eq!(manifest["profileId"], "codex-0.154-frozen-native-foreground-v1");
    assert_eq!(manifest["privateBridgeVersion"], 1);
    assert_eq!(manifest["upstreamCommit"], "6b9826e3aa83b1a5947db50f4332cb9c65f1b340");
    assert_eq!(manifest["integrationPatchSha256"],
        "fe327838f4e4c909d41eb36ec9d34b702ab87bec7ff7cb8c488064cc84ab8922");
    assert_eq!(manifest["nativeTool"], expected_native_tool());
    assert_eq!(manifest["commandSchemaSha256"], descriptor_sha(&expected_native_tool()["inputSchema"]));
    assert_eq!(manifest["catalogSha256"],
        descriptor_sha(&serde_json::to_value(fixed_catalog().expect("compiled catalog")).expect("catalog JSON")));
    assert_eq!(manifest["threadOptions"],
        serde_json::to_value(fixed_thread_params().expect("fixed thread")).expect("thread JSON"));
    let mut expected_turn = serde_json::to_value(
        fixed_turn_params("descriptor-thread".into(), "descriptor-input".into()).expect("fixed turn")
    ).expect("turn JSON");
    expected_turn.as_object_mut().expect("turn").remove("threadId");
    expected_turn.as_object_mut().expect("turn").remove("input");
    assert_eq!(manifest["turnOptions"], expected_turn);
    assert_eq!(manifest["commandAuthority"], json!({
        "execution": "general-purpose-foreground",
        "authority": "native-user-project",
        "sdkApprovalPrompt": false,
        "sdkSandbox": false,
        "activation": "fresh-native-panel-opt-in",
        "rpcActivationAllowed": false,
    }));
    assert_eq!(describe_profile().expect("second manifest"), manifest);
}

#[tokio::test]
async fn cmux_descriptor_reports_actual_sealed_values_and_exact_runtime_bindings() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let validated = capture_with_factory(fixture.inputs, |_| async {
        Ok(CloudConfigBundleLoader::default())
    }).await?;
    let notification = validated.descriptor().expect("must describe the sealed actual config");
    assert_eq!(notification.as_object().expect("notification").keys().cloned().collect::<Vec<_>>(),
        ["method", "params"]);
    assert_eq!(notification["method"], "cmux/codex/descriptor");
    let params = &notification["params"];
    assert_eq!(params.as_object().expect("params").keys().cloned().collect::<Vec<_>>(),
        ["bootNonce", "cwd", "effective", "profile", "profileDigest", "storeId"]);
    assert_eq!(params["bootNonce"], NONCE.to_string());
    assert_eq!(params["cwd"], serde_json::to_value(&validated.cwd)?);
    assert_eq!(params["storeId"], validated.store_id);
    assert_eq!(params["profile"], describe_profile().expect("manifest"));
    assert_eq!(params["profileDigest"], descriptor_sha(&params["profile"]));
    let config = &validated.config;
    let model = &config.model_catalog.as_ref().expect("sealed catalog").models[0];
    let modes = [false, true].map(|available| {
        codex_core::cmux_native_profile_tool_modes(config, model, available)
    });
    let features = EXCLUDED_FEATURES.iter()
        .map(|feature| (feature.key().to_string(), json!(config.features.enabled(*feature))))
        .collect::<serde_json::Map<String, Value>>();
    assert_eq!(params["effective"], json!({
        "model": config.model,
        "modelProviderId": config.model_provider_id,
        "ephemeral": config.ephemeral,
        "agentsEnabled": config.agents_enabled,
        "approvalPolicy": config.permissions.approval_policy.value(),
        "webSearch": config.web_search_mode.value(),
        "features": features,
        "toolModesByAvailability": modes,
        "catalogSha256": descriptor_sha(&serde_json::to_value(&config.model_catalog)?),
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
        "threadStore": {"type":"inMemory", "id":validated.store_id},
    }));
    Ok(())
}

#[tokio::test]
async fn cmux_descriptor_never_exports_raw_config_loaded_strings_or_runtime_paths() -> io::Result<()> {
    let mut fixture = Fixture::new()?;
    let raw_path = fixture.inputs.paths.codex_self_exe.clone().expect("fixture executable");
    fixture.inputs.builder = fixture.inputs.builder.harness_overrides(ConfigOverrides {
        cwd: Some(fixture.inputs.cwd.clone()),
        ephemeral: Some(true),
        codex_self_exe: fixture.inputs.paths.codex_self_exe.clone(),
        codex_linux_sandbox_exe: fixture.inputs.paths.codex_linux_sandbox_exe.clone(),
        main_execve_wrapper_exe: fixture.inputs.paths.main_execve_wrapper_exe.clone(),
        developer_instructions: Some("PRIVATE_FIXTURE_CONTEXT_DO_NOT_EXPORT".into()),
        ..ConfigOverrides::default()
    });
    let validated = capture_with_factory(fixture.inputs, |_| async {
        Ok(CloudConfigBundleLoader::default())
    }).await?;
    assert_eq!(validated.config.developer_instructions.as_deref(), Some("PRIVATE_FIXTURE_CONTEXT_DO_NOT_EXPORT"));
    let encoded = serde_json::to_string(&validated.descriptor().expect("safe descriptor"))?;
    for forbidden in ["PRIVATE_FIXTURE_CONTEXT_DO_NOT_EXPORT", "config_layer_stack",
        "developer_instructions", "api_key", "auth_config", "fixture-sandbox", "fixture-execve"] {
        assert!(!encoded.contains(forbidden), "descriptor leaked {forbidden}");
    }
    assert!(!encoded.contains(raw_path.to_str().expect("fixture UTF8")));
    assert!(!encoded.contains(validated.catalog.path().to_str().expect("fixture UTF8")));
    Ok(())
}

#[tokio::test]
async fn cmux_descriptor_is_snapshot_only_after_files_and_cloud_sources_change() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let config_path = fixture.home.path().join("config.toml");
    let calls = Arc::new(AtomicUsize::new(0));
    let loader = counted_loader(None, Arc::clone(&calls));
    let validated = capture_with_factory(fixture.inputs, |_| async move { Ok(loader) }).await?;
    let before = validated.descriptor().expect("first sealed descriptor");
    std::fs::write(config_path, "model = \"foreign-model\"\n")?;
    std::fs::write(validated.catalog.path().join("models.json"), "{}")?;
    assert_eq!(validated.descriptor().expect("sealed descriptor after mutation"), before);
    assert_eq!(calls.load(Ordering::SeqCst), 1, "descriptor reloaded cloud configuration");
    Ok(())
}

#[tokio::test]
async fn cmux_descriptor_separates_birth_binding_from_static_profile_identity() -> io::Result<()> {
    let first = Fixture::new()?;
    let mut second = Fixture::new()?;
    let nonce = Uuid::from_u128(0x00000000000040008000000000000002);
    second.inputs.boot_nonce = nonce;
    second.inputs.store_id = format!("cmux-{nonce}");
    let mut contents = std::fs::read_to_string(second.home.path().join("config.toml"))?;
    contents = contents.replace(&format!("cmux-{NONCE}"), &format!("cmux-{nonce}"));
    std::fs::write(second.home.path().join("config.toml"), contents)?;
    let first = capture_with_factory(first.inputs, |_| async {
        Ok(CloudConfigBundleLoader::default())
    }).await?;
    let second = capture_with_factory(second.inputs, |_| async {
        Ok(CloudConfigBundleLoader::default())
    }).await?;
    let a = first.descriptor().expect("first birth");
    let b = second.descriptor().expect("second birth");
    assert_ne!(a["params"]["bootNonce"], b["params"]["bootNonce"]);
    assert_ne!(a["params"]["storeId"], b["params"]["storeId"]);
    assert_ne!(a["params"]["cwd"], b["params"]["cwd"]);
    assert_eq!(a["params"]["profile"], b["params"]["profile"]);
    assert_eq!(a["params"]["profileDigest"], b["params"]["profileDigest"]);
    Ok(())
}

#[tokio::test]
async fn cmux_descriptor_refuses_synthetic_critical_policy_drift_before_export() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let mut validated = capture_with_factory(fixture.inputs, |_| async {
        Ok(CloudConfigBundleLoader::default())
    }).await?;
    validated.descriptor().expect("positive descriptor control");
    Arc::make_mut(&mut validated.config).features.set_enabled(Feature::Goals, true)?;
    let error = validated.descriptor().expect_err("critical policy drift must refuse export");
    assert!(error.to_string().contains("goals"), "lost policy field: {error}");
    Ok(())
}

fn expected_startup_initialize() -> codex_app_server_protocol::InitializeParams {
    codex_app_server_protocol::InitializeParams {
        client_info: codex_app_server_protocol::ClientInfo {
            name: "cmux-managed-codex-host".into(),
            title: None,
            version: env!("CARGO_PKG_VERSION").into(),
        },
        capabilities: Some(codex_app_server_protocol::InitializeCapabilities {
            experimental_api: true,
            request_attestation: false,
            mcp_server_openai_form_elicitation: false,
            opt_out_notification_methods: None,
            extensions: None,
        }),
    }
}

#[test]
fn cmux_descriptor_startup_initialize_matches_closed_sdk_contract() {
    let profile = describe_profile().expect("actual static profile");
    let expected = serde_json::to_value(expected_startup_initialize())
        .expect("typed fixed initialization JSON");
    assert_eq!(profile["startupOptions"]["initialize"], expected);
}

#[test]
fn cmux_descriptor_startup_session_source_is_native_owned() {
    let profile = describe_profile().expect("actual static profile");
    let expected = serde_json::to_value(
        codex_protocol::protocol::SessionSource::Custom("cmux".into()),
    ).expect("typed native-owned session source JSON");
    assert_eq!(profile["startupOptions"]["sessionSource"], expected);
}

#[test]
fn cmux_descriptor_startup_disables_api_key_env() {
    let profile = describe_profile().expect("actual static profile");
    assert_eq!(profile["startupOptions"]["enableCodexApiKeyEnv"], json!(false));
}

#[test]
fn cmux_descriptor_startup_sdk_channel_capacity_is_one() {
    let profile = describe_profile().expect("actual static profile");
    assert_eq!(profile["startupOptions"]["channelCapacity"], json!(1));
}

#[test]
fn cmux_descriptor_startup_options_have_only_four_source_owned_fields() {
    let profile = describe_profile().expect("actual static profile");
    let mut keys = profile["startupOptions"].as_object()
        .expect("actual startup options object").keys().cloned().collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys,
        ["channelCapacity", "enableCodexApiKeyEnv", "initialize", "sessionSource"]);
}
