use std::ffi::OsString;
use std::io;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Debug, PartialEq)]
enum Invocation {
    Describe,
    Private {
        boot_nonce: uuid::Uuid,
        cwd: PathBuf,
    },
}

fn parse(arguments: impl IntoIterator<Item = OsString>) -> io::Result<Invocation> {
    let arguments: Vec<_> = arguments.into_iter().take(6).collect();
    match arguments.as_slice() {
        [mode] if mode == "--describe-profile" => Ok(Invocation::Describe),
        [mode, nonce_flag, nonce, cwd_flag, cwd]
            if mode == "--private-stdio" && nonce_flag == "--boot-nonce" && cwd_flag == "--cwd" =>
        {
            let nonce = nonce.to_str().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "boot nonce must be UTF-8")
            })?;
            let boot_nonce = uuid::Uuid::parse_str(nonce)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
            if boot_nonce.is_nil() || boot_nonce.to_string() != nonce {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "boot nonce must be canonical and nonnil",
                ));
            }
            let cwd = PathBuf::from(cwd);
            if !cwd.is_absolute()
                || cwd.canonicalize()?.as_os_str() != cwd.as_os_str()
                || cwd != std::env::current_dir()?.canonicalize()?
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "cwd must be the canonical actual process directory",
                ));
            }
            Ok(Invocation::Private { boot_nonce, cwd })
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unsupported invocation",
        )),
    }
}

fn write_profile() -> io::Result<()> {
    let profile = cmux_managed_codex_host::descriptor::describe_profile()?;
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, &profile)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn main() -> ExitCode {
    match parse(std::env::args_os().skip(1)) {
        Ok(Invocation::Describe) => match write_profile() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("cmux-managed-codex-host: profile output failed: {error}");
                ExitCode::FAILURE
            }
        },
        Ok(Invocation::Private { boot_nonce, cwd }) => {
            match cmux_managed_codex_host::run_private(boot_nonce, &cwd) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("cmux-managed-codex-host: private startup failed: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        Err(error) => {
            eprintln!("cmux-managed-codex-host: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    const NONCE: &str = "00000000-0000-4000-8000-000000000001";

    fn private(cwd: impl Into<OsString>) -> Vec<OsString> {
        vec![
            "--private-stdio".into(),
            "--boot-nonce".into(),
            NONCE.into(),
            "--cwd".into(),
            cwd.into(),
        ]
    }

    #[test]
    fn cmux_entry_parse_accepts_exact_private_birth() -> io::Result<()> {
        let cwd = std::env::current_dir()?.canonicalize()?;
        let parsed = parse(private(cwd.clone()));
        assert!(parsed.is_ok(), "CMUX_PRIVATE_ENTRY_UNAVAILABLE: {parsed:?}");
        assert_eq!(
            parsed?,
            Invocation::Private {
                boot_nonce: uuid::Uuid::from_u128(0x40008000000000000001),
                cwd,
            }
        );
        Ok(())
    }

    #[test]
    fn cmux_entry_parse_describe_is_exact_and_needs_no_runtime() {
        assert_eq!(
            parse([OsString::from("--describe-profile")]).unwrap(),
            Invocation::Describe
        );
        assert!(parse(["--describe-profile".into(), "--private-stdio".into()]).is_err());
        assert!(parse(Vec::<OsString>::new()).is_err());
    }

    #[test]
    fn cmux_entry_parse_rejects_missing_or_repeated_birth_fields() -> io::Result<()> {
        let valid = private(std::env::current_dir()?.canonicalize()?);
        for length in 1..valid.len() {
            assert!(parse(valid[..length].to_vec()).is_err());
        }
        for extra in ["--boot-nonce", "--cwd", "--private-stdio"] {
            let mut arguments = valid.clone();
            arguments.extend([extra.into(), NONCE.into()]);
            assert!(parse(arguments).is_err());
        }
        Ok(())
    }

    #[test]
    fn cmux_entry_parse_rejects_noncanonical_or_nil_nonce() -> io::Result<()> {
        for nonce in [
            "00000000-0000-0000-0000-000000000000",
            "00000000000040008000000000000001",
            "00000000-0000-4000-8000-00000000000A",
            "not-a-uuid",
            "",
        ] {
            let mut arguments = private(std::env::current_dir()?.canonicalize()?);
            arguments[2] = nonce.into();
            assert!(parse(arguments).is_err(), "accepted nonce {nonce:?}");
        }
        let mut arguments = private(std::env::current_dir()?.canonicalize()?);
        arguments[2] = OsString::from_vec(vec![0xff]);
        assert!(parse(arguments).is_err(), "nonce was decoded lossily");
        Ok(())
    }

    #[test]
    fn cmux_entry_parse_rejects_foreign_relative_missing_and_file_cwd() -> io::Result<()> {
        let foreign = tempfile::TempDir::new()?;
        let file = tempfile::NamedTempFile::new()?;
        for cwd in [
            PathBuf::from("."),
            foreign.path().canonicalize()?,
            foreign.path().join("absent"),
            file.path().canonicalize()?,
        ] {
            assert!(parse(private(cwd)).is_err());
        }
        Ok(())
    }

    #[test]
    fn cmux_entry_parse_rejects_noncanonical_cwd_spelling_and_symlink() -> io::Result<()> {
        let cwd = std::env::current_dir()?.canonicalize()?;
        assert!(parse(private(cwd.join("."))).is_err());
        let temporary = tempfile::TempDir::new()?;
        let alias = temporary.path().join("alias");
        std::os::unix::fs::symlink(cwd, &alias)?;
        assert!(parse(private(alias)).is_err());
        Ok(())
    }

    #[test]
    fn cmux_entry_parse_rejects_upstream_helpers_and_configuration_passthrough() -> io::Result<()> {
        for flag in [
            "apply-patch",
            "--codex-run-as-apply-patch",
            "exec",
            "app-server",
            "--config",
            "-c",
            "--profile",
            "--sandbox",
            "--model",
            "--help",
        ] {
            assert!(parse([OsString::from(flag)]).is_err());
            let mut arguments = private(std::env::current_dir()?.canonicalize()?);
            arguments.push(flag.into());
            assert!(parse(arguments).is_err(), "private parser accepted {flag}");
        }
        Ok(())
    }

    #[test]
    fn cmux_entry_parse_rejects_non_utf8_mode_without_coercion() {
        assert!(parse([OsString::from_vec(vec![0xff])]).is_err());
    }
}
