use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

use codex_config::LoaderOverrides;
use codex_protocol::protocol::AskForApproval;

const NONCE: Uuid = Uuid::from_u128(0x00000000000040008000000000000011);

struct Fixture {
    home: TempDir,
    inputs: CaptureInputs,
}

impl Fixture {
    fn new(nonce: Uuid) -> io::Result<Self> {
        let home = TempDir::new()?;
        let cwd = home.path().canonicalize()?;
        let profile = ClosedProfile::new(Arg0DispatchPaths {
            codex_self_exe: Some(cwd.join("fixture-host")),
            codex_linux_sandbox_exe: Some(cwd.join("fixture-sandbox")),
            main_execve_wrapper_exe: Some(cwd.join("fixture-execve")),
        });
        let mut inputs = CaptureInputs::prepare(nonce, &cwd, profile.paths)?;
        // Only the external policy locations are isolated; all native inputs come from production preparation.
        inputs.builder = inputs.builder
            .codex_home(home.path().to_path_buf())
            .loader_overrides(LoaderOverrides {
                managed_config_path: Some(home.path().join("managed.toml")),
                system_config_path: Some(home.path().join("system.toml")),
                system_requirements_path: Some(home.path().join("requirements.toml")),
                ignore_project_config: true,
                ..LoaderOverrides::without_managed_config_for_tests()
            });
        Ok(Self { home, inputs })
    }
}

fn loader(calls: Arc<AtomicUsize>) -> CloudConfigBundleLoader {
    CloudConfigBundleLoader::from_getter(move || {
        calls.fetch_add(1, Ordering::SeqCst);
        async { Ok(None) }
    })
}

#[tokio::test]
async fn cmux_preparation_fixed_native_inputs_are_actual_derived_policy() -> io::Result<()> {
    let fixture = Fixture::new(NONCE)?;
    std::fs::write(
        fixture.home.path().join("config.toml"),
        "model = \"user-model\"\nmodel_provider = \"openai\"\n\
         approval_policy = \"on-request\"\nweb_search = \"live\"\n\
         [agents]\nenabled = true\n\
         [orchestrator.skills]\nenabled = true\n\
         [orchestrator.mcp]\nenabled = true\n\
         [memories]\ngenerate_memories = true\nuse_memories = true\ndedicated_tools = true\n\
         [features]\ngoals = true\ncode_mode = true\n",
    )?;
    let cwd = fixture.inputs.cwd.clone();
    let paths = fixture.inputs.paths.clone();
    let store_id = fixture.inputs.store_id.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let cloud = loader(Arc::clone(&calls));
    let validated = capture_with_factory(fixture.inputs, |_| async move { Ok(cloud) }).await?;
    check_derived_policy(&validated.config, &cwd, &store_id)?;
    assert_eq!(validated.boot_nonce, NONCE);
    assert_eq!(validated.cwd, cwd);
    assert_eq!(validated.store_id, store_id);
    assert!(same_path(&validated.paths.codex_self_exe, &paths.codex_self_exe));
    assert!(same_path(&validated.paths.codex_linux_sandbox_exe, &paths.codex_linux_sandbox_exe));
    assert!(same_path(&validated.paths.main_execve_wrapper_exe, &paths.main_execve_wrapper_exe));
    assert_eq!(validated.config.model_catalog, Some(fixed_catalog()?));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn cmux_preparation_retains_managed_requirements_and_loaded_strings() -> io::Result<()> {
    let fixture = Fixture::new(NONCE)?;
    let config_path = fixture.home.path().join("config.toml");
    let requirements_path = fixture.home.path().join("requirements.toml");
    std::fs::write(&config_path, "developer_instructions = \"retained fixture instructions\"\n")?;
    std::fs::write(&requirements_path, "allowed_approval_policies = [\"never\"]\n")?;
    let expected = fixture.inputs.builder.clone().build().await?;
    assert_eq!(expected.developer_instructions.as_deref(), Some("retained fixture instructions"));
    let calls = Arc::new(AtomicUsize::new(0));
    let cloud = loader(Arc::clone(&calls));
    let validated = capture_with_factory(fixture.inputs, |_| async move { Ok(cloud) }).await?;
    assert_eq!(validated.config.as_ref(), &expected);
    std::fs::write(config_path, "developer_instructions = \"changed fixture instructions\"\n")?;
    std::fs::write(requirements_path, "allowed_approval_policies = [\"on-request\"]\n")?;
    assert_eq!(validated.config.as_ref(), &expected);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn cmux_preparation_managed_approval_normalization_is_rejected_before_seal() -> io::Result<()> {
    let fixture = Fixture::new(NONCE)?;
    std::fs::write(
        fixture.home.path().join("requirements.toml"),
        "allowed_approval_policies = [\"on-request\"]\n",
    )?;
    let independent = fixture.inputs.builder.clone().build().await?;
    assert_eq!(independent.permissions.approval_policy.value(), AskForApproval::OnRequest);
    let factories = AtomicUsize::new(0);
    let calls = Arc::new(AtomicUsize::new(0));
    let cloud = loader(Arc::clone(&calls));
    let result = capture_with_factory(fixture.inputs, |_| {
        factories.fetch_add(1, Ordering::SeqCst);
        async move { Ok(cloud) }
    }).await;
    let error = result.err().expect("production native overrides must not bypass managed requirements");
    assert!(error.to_string().contains("approval_policy"), "{error}");
    assert_eq!(factories.load(Ordering::SeqCst), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn cmux_preparation_unoverridden_notify_is_rejected_before_seal() -> io::Result<()> {
    let fixture = Fixture::new(NONCE)?;
    std::fs::write(fixture.home.path().join("config.toml"), "notify = [\"fixture-no-execution\"]\n")?;
    let independent = fixture.inputs.builder.clone().build().await?;
    assert_eq!(independent.notify, Some(vec!["fixture-no-execution".to_owned()]));
    let calls = Arc::new(AtomicUsize::new(0));
    let cloud = loader(Arc::clone(&calls));
    let result = capture_with_factory(fixture.inputs, |_| async move { Ok(cloud) }).await;
    let error = result.err().expect("legacy notify must reject capture");
    assert!(error.to_string().contains("legacy_notify"), "{error}");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[test]
fn cmux_preparation_invalid_birth_never_prepares_a_profile() -> io::Result<()> {
    let home = TempDir::new()?;
    let cwd = home.path().canonicalize()?;
    assert!(CaptureInputs::prepare(Uuid::nil(), &cwd, Arg0DispatchPaths::default()).is_err());
    assert!(CaptureInputs::prepare(NONCE, Path::new("."), Arg0DispatchPaths::default()).is_err());
    assert!(CaptureInputs::prepare(NONCE, &cwd.join("."), Arg0DispatchPaths::default()).is_err());
    Ok(())
}

#[tokio::test]
async fn cmux_preparation_distinct_births_have_distinct_actual_memory_stores() -> io::Result<()> {
    let first = Fixture::new(NONCE)?;
    let other_nonce = Uuid::from_u128(0x00000000000040008000000000000012);
    let second = Fixture::new(other_nonce)?;
    let first_capture = capture_with_factory(first.inputs, |_| async {
        Ok(CloudConfigBundleLoader::default())
    }).await?;
    let second_capture = capture_with_factory(second.inputs, |_| async {
        Ok(CloudConfigBundleLoader::default())
    }).await?;
    assert_eq!(first_capture.store_id, format!("cmux-{NONCE}"));
    assert_eq!(second_capture.store_id, format!("cmux-{other_nonce}"));
    assert_ne!(first_capture.store_id, second_capture.store_id);
    assert_ne!(
        first_capture.config.experimental_thread_store,
        second_capture.config.experimental_thread_store,
    );
    Ok(())
}
