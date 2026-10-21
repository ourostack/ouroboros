use std::future::Future;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use codex_arg0::Arg0DispatchPaths;
use codex_config::CloudConfigBundleLoader;
use codex_core::config::Config;
use codex_core::config::ConfigBuilder;
use codex_core::config::ConfigOverrides;
use codex_login::AuthConfig;
use tempfile::TempDir;
use uuid::Uuid;

use crate::policy::EXCLUDED_FEATURES;
use crate::policy::check_derived_policy;
use crate::profile::fixed_catalog;

pub struct ClosedProfile {
    paths: Arg0DispatchPaths,
}

impl ClosedProfile {
    pub(crate) fn new(paths: Arg0DispatchPaths) -> Self {
        Self { paths }
    }

    pub async fn capture(self, boot_nonce: Uuid, cwd: &Path) -> io::Result<ValidatedConfig> {
        let inputs = CaptureInputs::prepare(boot_nonce, cwd, self.paths)?;
        capture_with_factory(inputs, |auth| {
            codex_cloud_config::cloud_config_bundle_loader_for_storage_without_cache(auth, false)
        }).await
    }
}

#[cfg(test)]
#[path = "preparation_tests.rs"]
mod preparation_tests;

pub struct ValidatedConfig {
    config: Arc<Config>,
    boot_nonce: Uuid,
    cwd: PathBuf,
    store_id: String,
    paths: Arg0DispatchPaths,
    catalog: TempDir,
}

impl ValidatedConfig {
    pub fn descriptor(&self) -> io::Result<serde_json::Value> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "safe descriptor not implemented"))
    }
}

struct CaptureInputs {
    builder: ConfigBuilder,
    boot_nonce: Uuid,
    cwd: PathBuf,
    store_id: String,
    paths: Arg0DispatchPaths,
    catalog: TempDir,
}

fn require(condition: bool, field: &'static str) -> io::Result<()> {
    if condition {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("native capture conflict: {field}"),
        ))
    }
}

fn check_birth(boot_nonce: Uuid, cwd: &Path, store_id: &str) -> io::Result<()> {
    require(!boot_nonce.is_nil(), "boot_nonce")?;
    require(cwd.is_absolute() && cwd.is_dir(), "cwd")?;
    require(cwd.canonicalize()?.as_os_str() == cwd.as_os_str(), "canonical_cwd")?;
    require(store_id == format!("cmux-{boot_nonce}"), "nonce_thread_store")
}

fn same_path(left: &Option<PathBuf>, right: &Option<PathBuf>) -> bool {
    left.as_ref().map(|path| path.as_os_str()) == right.as_ref().map(|path| path.as_os_str())
}

impl CaptureInputs {
    fn prepare(boot_nonce: Uuid, cwd: &Path, paths: Arg0DispatchPaths) -> io::Result<Self> {
        let store_id = format!("cmux-{boot_nonce}");
        check_birth(boot_nonce, cwd, &store_id)?;
        let catalog = tempfile::Builder::new().prefix("cmux-managed-codex-profile-").tempdir()?;
        let catalog_path = catalog.path().join("models.json");
        std::fs::write(&catalog_path, serde_json::to_vec(&fixed_catalog()?)?)?;
        let mut values = vec![
            ("model", serde_json::json!("gpt-5.5")),
            ("model_provider", serde_json::json!("openai")),
            ("approval_policy", serde_json::json!("never")),
            ("web_search", serde_json::json!("disabled")),
            ("model_catalog_json", serde_json::to_value(&catalog_path)?),
            ("experimental_thread_store", serde_json::json!({
                "type": "in_memory", "id": store_id,
            })),
            ("mcp_servers", serde_json::json!({})),
            ("agents.enabled", serde_json::json!(false)),
            ("orchestrator.skills.enabled", serde_json::json!(false)),
            ("orchestrator.mcp.enabled", serde_json::json!(false)),
            ("memories.generate_memories", serde_json::json!(false)),
            ("memories.use_memories", serde_json::json!(false)),
            ("memories.dedicated_tools", serde_json::json!(false)),
        ].into_iter().map(|(key, value)| {
            Ok((key.to_owned(), serde_json::from_value(value)?))
        }).collect::<io::Result<Vec<(String, codex_config::TomlValue)>>>()?;
        for feature in EXCLUDED_FEATURES {
            values.push((
                format!("features.{}", feature.key()),
                serde_json::from_value(serde_json::json!(false))?,
            ));
        }
        let builder = ConfigBuilder::default()
            .cli_overrides(values)
            .harness_overrides(ConfigOverrides {
                cwd: Some(cwd.to_path_buf()),
                ephemeral: Some(true),
                codex_self_exe: paths.codex_self_exe.clone(),
                codex_linux_sandbox_exe: paths.codex_linux_sandbox_exe.clone(),
                main_execve_wrapper_exe: paths.main_execve_wrapper_exe.clone(),
                ..ConfigOverrides::default()
            })
            .strict_config(true);
        Ok(Self { builder, boot_nonce, cwd: cwd.to_path_buf(), store_id, paths, catalog })
    }
}

async fn capture_with_factory<F, Fut>(
    inputs: CaptureInputs,
    factory: F,
) -> io::Result<ValidatedConfig>
where
    F: FnOnce(AuthConfig) -> Fut,
    Fut: Future<Output = io::Result<CloudConfigBundleLoader>>,
{
    let CaptureInputs { builder, boot_nonce, cwd, store_id, paths, catalog } = inputs;
    check_birth(boot_nonce, &cwd, &store_id)?;
    for path in [&paths.codex_self_exe, &paths.codex_linux_sandbox_exe, &paths.main_execve_wrapper_exe] {
        require(path.as_ref().is_none_or(|path| path.is_absolute()), "runtime_path")?;
    }
    // The preliminary normal local build derives auth policy only; cloud participates in the final build.
    let auth = builder.clone()
        .cloud_config_bundle(CloudConfigBundleLoader::default())
        .build().await?.auth_config();
    let cloud = factory(auth).await?;
    let config = builder.cloud_config_bundle(cloud).build().await?;
    check_derived_policy(&config, &cwd, &store_id)?;
    require(same_path(&config.codex_self_exe, &paths.codex_self_exe), "codex_self_exe")?;
    require(
        same_path(&config.codex_linux_sandbox_exe, &paths.codex_linux_sandbox_exe),
        "codex_linux_sandbox_exe",
    )?;
    require(
        same_path(&config.main_execve_wrapper_exe, &paths.main_execve_wrapper_exe),
        "main_execve_wrapper_exe",
    )?;
    Ok(ValidatedConfig { config: Arc::new(config), boot_nonce, cwd, store_id, paths, catalog })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use codex_config::CloudConfigBundle;
    use codex_config::CloudConfigBundleLoadError;
    use codex_config::CloudConfigBundleLoadErrorCode;
    use codex_config::CloudRequirementsFragment;
    use codex_config::CloudRequirementsTomlBundle;
    use codex_config::LoaderOverrides;
    use codex_core::config::ConfigOverrides;
    use codex_features::Feature;

    use crate::policy::check_derived_policy;
    use crate::profile::fixed_catalog;

    const NONCE: Uuid = Uuid::from_u128(0x00000000000040008000000000000001);

    struct Fixture {
        home: TempDir,
        inputs: CaptureInputs,
    }

    impl Fixture {
        fn new() -> io::Result<Self> {
            let home = TempDir::new()?;
            let cwd = home.path().canonicalize()?;
            let catalog = TempDir::new()?;
            let catalog_path = catalog.path().join("models.json");
            std::fs::write(&catalog_path, serde_json::to_vec(&fixed_catalog()?)?)?;
            let store_id = format!("cmux-{NONCE}");
            let paths = Arg0DispatchPaths {
                codex_self_exe: Some(cwd.join("fixture-host")),
                codex_linux_sandbox_exe: Some(cwd.join("fixture-sandbox")),
                main_execve_wrapper_exe: Some(cwd.join("fixture-execve")),
            };
            let mut contents = format!(
                "model = \"gpt-5.5\"\nmodel_provider = \"openai\"\n\
                 approval_policy = \"never\"\nweb_search = \"disabled\"\n\
                 model_catalog_json = {}\n\
                 experimental_thread_store = {{ type = \"in_memory\", id = \"{store_id}\" }}\n\
                 [agents]\nenabled = false\n\
                 [orchestrator.skills]\nenabled = false\n\
                 [orchestrator.mcp]\nenabled = false\n\
                 [memories]\ngenerate_memories = false\nuse_memories = false\ndedicated_tools = false\n\
                 [features]\n",
                serde_json::to_string(&catalog_path)?,
            );
            for feature in [
                Feature::MultiAgentV2, Feature::Goals, Feature::MemoryTool,
                Feature::GuardianApproval, Feature::SleepTool, Feature::CodeMode,
                Feature::CodeModeOnly, Feature::CodeModePrewarm, Feature::CodexHooks,
                Feature::WebSearchRequest, Feature::WebSearchCached, Feature::ImageGeneration,
                Feature::Apps, Feature::Plugins, Feature::SkillMcpDependencyInstall,
                Feature::SkillSearch,
            ] {
                contents.push_str(&format!("{} = false\n", feature.key()));
            }
            std::fs::write(home.path().join("config.toml"), contents)?;
            let builder = ConfigBuilder::default()
                .codex_home(home.path().to_path_buf())
                .cli_overrides(vec![("mcp_servers".into(), serde_json::from_str("{}")?)])
                .loader_overrides(LoaderOverrides {
                    managed_config_path: Some(home.path().join("managed.toml")),
                    system_config_path: Some(home.path().join("system.toml")),
                    system_requirements_path: Some(home.path().join("requirements.toml")),
                    ignore_project_config: true,
                    ..LoaderOverrides::without_managed_config_for_tests()
                })
                .harness_overrides(ConfigOverrides {
                    cwd: Some(cwd.clone()),
                    ephemeral: Some(true),
                    codex_self_exe: paths.codex_self_exe.clone(),
                    codex_linux_sandbox_exe: paths.codex_linux_sandbox_exe.clone(),
                    main_execve_wrapper_exe: paths.main_execve_wrapper_exe.clone(),
                    ..ConfigOverrides::default()
                })
                .strict_config(true)
                .thread_config_loader(Arc::new(codex_config::NoopThreadConfigLoader));
            Ok(Self {
                home,
                inputs: CaptureInputs {
                    builder,
                    boot_nonce: NONCE,
                    cwd,
                    store_id,
                    paths,
                    catalog,
                },
            })
        }
    }

    fn requirements(contents: String) -> CloudConfigBundle {
        CloudConfigBundle {
            requirements_toml: CloudRequirementsTomlBundle {
                enterprise_managed: vec![CloudRequirementsFragment {
                    id: "capture-requirements".into(),
                    name: "Capture requirements fixture".into(),
                    contents,
                }],
            },
            ..CloudConfigBundle::default()
        }
    }

    fn counted_loader(
        bundle: Option<CloudConfigBundle>,
        calls: Arc<AtomicUsize>,
    ) -> CloudConfigBundleLoader {
        CloudConfigBundleLoader::from_getter(move || {
            calls.fetch_add(1, Ordering::SeqCst);
            let bundle = bundle.clone();
            async move { Ok(bundle) }
        })
    }

    #[tokio::test]
    async fn capture_fixture_actual_builder_positive_control() -> io::Result<()> {
        let fixture = Fixture::new()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let bundle = requirements("allowed_approval_policies = [\"never\"]\n".into());
        let config = fixture.inputs.builder.clone()
            .cloud_config_bundle(counted_loader(Some(bundle), Arc::clone(&calls)))
            .build().await?;
        check_derived_policy(&config, &fixture.inputs.cwd, &fixture.inputs.store_id)?;
        assert_eq!(config.codex_self_exe, fixture.inputs.paths.codex_self_exe);
        assert_eq!(config.codex_linux_sandbox_exe, fixture.inputs.paths.codex_linux_sandbox_exe);
        assert_eq!(config.main_execve_wrapper_exe, fixture.inputs.paths.main_execve_wrapper_exe);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        Ok(())
    }

    #[tokio::test]
    async fn capture_preserves_actual_config_and_all_runtime_bindings() -> io::Result<()> {
        let fixture = Fixture::new()?;
        let expected = fixture.inputs.builder.clone().build().await?;
        check_derived_policy(&expected, &fixture.inputs.cwd, &fixture.inputs.store_id)?;
        let cwd = fixture.inputs.cwd.clone();
        let paths = fixture.inputs.paths.clone();
        let store_id = fixture.inputs.store_id.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let factory_calls = Arc::new(AtomicUsize::new(0));
        let factory_count = Arc::clone(&factory_calls);
        let loader = counted_loader(None, Arc::clone(&calls));
        let expected_auth_home = expected.auth_config().codex_home;
        let validated = capture_with_factory(fixture.inputs, move |auth| async move {
            factory_count.fetch_add(1, Ordering::SeqCst);
            assert_eq!(auth.codex_home, expected_auth_home);
            Ok(loader)
        }).await.expect("capture must seal valid actual config");
        assert_eq!(validated.config.as_ref(), &expected);
        assert_eq!(validated.boot_nonce, NONCE);
        assert_eq!(validated.cwd, cwd);
        assert_eq!(validated.store_id, store_id);
        assert_eq!(validated.paths.codex_self_exe, paths.codex_self_exe);
        assert_eq!(validated.paths.codex_linux_sandbox_exe, paths.codex_linux_sandbox_exe);
        assert_eq!(validated.paths.main_execve_wrapper_exe, paths.main_execve_wrapper_exe);
        assert_eq!(factory_calls.load(Ordering::SeqCst), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(validated.catalog.path().join("models.json").is_file());
        Ok(())
    }

    #[tokio::test]
    async fn capture_preserves_compatible_cloud_requirements_and_provenance() -> io::Result<()> {
        let fixture = Fixture::new()?;
        let bundle = requirements("allowed_approval_policies = [\"never\"]\n[features]\ngoals = false\n".into());
        let expected = fixture.inputs.builder.clone()
            .cloud_config_bundle(counted_loader(Some(bundle.clone()), Arc::new(AtomicUsize::new(0))))
            .build().await?;
        check_derived_policy(&expected, &fixture.inputs.cwd, &fixture.inputs.store_id)?;
        let without_cloud = fixture.inputs.builder.clone().build().await?;
        assert_ne!(expected.config_layer_stack, without_cloud.config_layer_stack);
        let calls = Arc::new(AtomicUsize::new(0));
        let loader = counted_loader(Some(bundle), Arc::clone(&calls));
        let validated = capture_with_factory(fixture.inputs, |_| async move { Ok(loader) })
            .await.expect("capture must preserve compatible cloud requirements");
        assert_eq!(validated.config.as_ref(), &expected);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        Ok(())
    }

    async fn reject_cloud_conflict(contents: String) -> io::Result<()> {
        let fixture = Fixture::new()?;
        let bundle = requirements(contents);
        let independent = fixture.inputs.builder.clone()
            .cloud_config_bundle(counted_loader(Some(bundle.clone()), Arc::new(AtomicUsize::new(0))))
            .build().await;
        match independent {
            Ok(config) => assert!(
                check_derived_policy(&config, &fixture.inputs.cwd, &fixture.inputs.store_id).is_err(),
                "cloud fixture did not cause an actual derived conflict",
            ),
            Err(error) => assert!(!error.to_string().is_empty()),
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let loader = counted_loader(Some(bundle), Arc::clone(&calls));
        assert!(capture_with_factory(fixture.inputs, |_| async move { Ok(loader) }).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1, "capture did not reach actual final build");
        Ok(())
    }

    #[tokio::test]
    async fn capture_rejects_actual_cloud_goals_requirement_without_fallback() -> io::Result<()> {
        reject_cloud_conflict("[features]\ngoals = true\n".into()).await
    }

    #[tokio::test]
    async fn capture_rejects_actual_cloud_approval_requirement_without_fallback() -> io::Result<()> {
        reject_cloud_conflict("allowed_approval_policies = [\"on-request\"]\n".into()).await
    }

    #[tokio::test]
    async fn capture_rejects_actual_cloud_catalog_requirement_without_fallback() -> io::Result<()> {
        let other = TempDir::new()?;
        let path = other.path().join("other-models.json");
        let mut catalog = fixed_catalog()?;
        catalog.models[0].display_name.push_str(" conflicting requirement");
        std::fs::write(&path, serde_json::to_vec(&catalog)?)?;
        reject_cloud_conflict(format!("model_catalog_json = {}\n", serde_json::to_string(&path)?)).await
    }

    #[tokio::test]
    async fn capture_propagates_cloud_error_instead_of_sealing_local_config() -> io::Result<()> {
        let fixture = Fixture::new()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&calls);
        let loader = CloudConfigBundleLoader::from_getter(move || {
            count.fetch_add(1, Ordering::SeqCst);
            async {
                Err(CloudConfigBundleLoadError::new(
                    CloudConfigBundleLoadErrorCode::Timeout, None, "fixture cloud timeout",
                ))
            }
        });
        let error = capture_with_factory(fixture.inputs, |_| async move { Ok(loader) })
            .await.err().expect("cloud failure must reject capture");
        assert!(error.to_string().contains("fixture cloud timeout"), "cloud error lost: {error}");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "cloud getter must be invoked once");
        Ok(())
    }

    #[tokio::test]
    async fn capture_propagates_factory_construction_error() -> io::Result<()> {
        let fixture = Fixture::new()?;
        let calls = AtomicUsize::new(0);
        let error = capture_with_factory(fixture.inputs, |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(io::Error::new(io::ErrorKind::PermissionDenied, "fixture factory refused")) }
        }).await.err().expect("factory error must reject capture");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "cloud factory must be invoked once");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(error.to_string(), "fixture factory refused");
        Ok(())
    }

    #[tokio::test]
    async fn capture_preliminary_build_failure_never_calls_cloud_factory() -> io::Result<()> {
        let fixture = Fixture::new()?;
        std::fs::write(fixture.home.path().join("config.toml"), "model = [invalid")?;
        let calls = AtomicUsize::new(0);
        let result = capture_with_factory(fixture.inputs, |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(CloudConfigBundleLoader::default()) }
        }).await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        Ok(())
    }

    async fn reject_before_cloud(inputs: CaptureInputs) {
        let calls = AtomicUsize::new(0);
        let result = capture_with_factory(inputs, |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(CloudConfigBundleLoader::default()) }
        }).await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn capture_rejects_nil_nonce_before_cloud() -> io::Result<()> {
        let mut fixture = Fixture::new()?;
        fixture.inputs.boot_nonce = Uuid::nil();
        reject_before_cloud(fixture.inputs).await;
        Ok(())
    }

    #[tokio::test]
    async fn capture_rejects_relative_cwd_before_cloud() -> io::Result<()> {
        let mut fixture = Fixture::new()?;
        fixture.inputs.cwd = PathBuf::from(".");
        reject_before_cloud(fixture.inputs).await;
        Ok(())
    }

    #[tokio::test]
    async fn capture_rejects_noncanonical_cwd_before_cloud() -> io::Result<()> {
        let mut fixture = Fixture::new()?;
        fixture.inputs.cwd = fixture.inputs.cwd.join(".");
        reject_before_cloud(fixture.inputs).await;
        Ok(())
    }

    #[tokio::test]
    async fn capture_rejects_runtime_path_drift_before_sealing() -> io::Result<()> {
        for field in 0..3 {
            let mut fixture = Fixture::new()?;
            let drift = Some(fixture.inputs.cwd.join("different-runtime"));
            match field {
                0 => fixture.inputs.paths.codex_self_exe = drift,
                1 => fixture.inputs.paths.codex_linux_sandbox_exe = drift,
                _ => fixture.inputs.paths.main_execve_wrapper_exe = drift,
            }
            assert!(capture_with_factory(fixture.inputs, |_| async {
                Ok(CloudConfigBundleLoader::default())
            }).await.is_err(), "accepted runtime field {field} drift");
        }
        Ok(())
    }

    #[tokio::test]
    async fn capture_rejects_store_not_bound_to_nonce() -> io::Result<()> {
        let mut fixture = Fixture::new()?;
        fixture.inputs.boot_nonce = Uuid::from_u128(0x00000000000040008000000000000002);
        assert!(capture_with_factory(fixture.inputs, |_| async {
            Ok(CloudConfigBundleLoader::default())
        }).await.is_err());
        Ok(())
    }

    #[tokio::test]
    async fn capture_discards_reload_inputs_and_retains_same_snapshot() -> io::Result<()> {
        let fixture = Fixture::new()?;
        let config_path = fixture.home.path().join("config.toml");
        let state = Arc::new(Mutex::new(Some(requirements(
            "allowed_approval_policies = [\"never\"]\n".into(),
        ))));
        let cloud_state = Arc::clone(&state);
        let calls = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&calls);
        let lifetime = Arc::new(());
        let weak = Arc::downgrade(&lifetime);
        let loader = CloudConfigBundleLoader::from_getter(move || {
            let _keep = &lifetime;
            count.fetch_add(1, Ordering::SeqCst);
            let bundle = cloud_state.lock().expect("fixture state").clone();
            async move { Ok(bundle) }
        });
        let validated = capture_with_factory(fixture.inputs, |_| async move { Ok(loader) })
            .await.expect("capture must freeze a valid snapshot");
        assert!(weak.upgrade().is_none(), "sealed capability retained the reload closure");
        let original = Arc::clone(&validated.config);
        let original_values = original.as_ref().clone();
        std::fs::write(config_path, "model = \"changed-on-disk\"\n")?;
        std::fs::write(validated.catalog.path().join("models.json"), "{}")?;
        *state.lock().expect("fixture state") = Some(requirements("[features]\ngoals = true\n".into()));
        assert!(Arc::ptr_eq(&original, &validated.config));
        assert_eq!(validated.config.as_ref(), &original_values);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        Ok(())
    }

    include!("descriptor_tests.rs");
}
