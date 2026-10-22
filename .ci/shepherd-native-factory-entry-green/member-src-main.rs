use std::io;
use std::io::Write;
use std::process::ExitCode;

fn write_profile() -> io::Result<()> {
    let profile = cmux_managed_codex_host::descriptor::describe_profile()?;
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, &profile)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn main() -> ExitCode {
    let mut arguments = std::env::args_os().skip(1);
    match (arguments.next(), arguments.next()) {
        (Some(mode), None) if mode == "--describe-profile" => match write_profile() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("cmux-managed-codex-host: profile output failed: {error}");
                ExitCode::FAILURE
            }
        },
        _ => {
            eprintln!(
                "cmux-managed-codex-host: unsupported invocation; private startup unavailable"
            );
            ExitCode::FAILURE
        }
    }
}
