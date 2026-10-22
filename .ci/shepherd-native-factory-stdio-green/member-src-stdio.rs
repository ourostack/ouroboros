use std::fs::File;
use std::io;
use std::io::{Read, Write};
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::fs::FileTypeExt;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll, ready};

use codex_arg0::Arg0DispatchPaths;
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use uuid::Uuid;

pub(crate) struct PipeReader(AsyncFd<File>);
pub(crate) struct PipeWriter(AsyncFd<File>);

fn pipe(file: File, direction: libc::c_int, interest: Interest) -> io::Result<AsyncFd<File>> {
    if !file.metadata()?.file_type().is_fifo() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private stdio requires anonymous pipes",
        ));
    }
    // The owned File keeps this descriptor live throughout both integer-only fcntl calls.
    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_ACCMODE != direction {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private stdio pipe direction differs",
        ));
    }
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(io::Error::last_os_error());
    }
    AsyncFd::with_interest(file, interest)
}

impl PipeReader {
    pub(crate) fn new(file: File) -> io::Result<Self> {
        pipe(file, libc::O_RDONLY, Interest::READABLE).map(Self)
    }
}

impl PipeWriter {
    pub(crate) fn new(file: File) -> io::Result<Self> {
        pipe(file, libc::O_WRONLY, Interest::WRITABLE).map(Self)
    }
}

impl AsyncRead for PipeReader {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        loop {
            let mut guard = ready!(self.0.poll_read_ready(context))?;
            match guard.try_io(|inner| inner.get_ref().read(buffer.initialize_unfilled())) {
                Ok(Ok(count)) => {
                    buffer.advance(count);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => continue,
                Ok(Err(error)) => return Poll::Ready(Err(error)),
                Err(_would_block) => continue,
            }
        }
    }
}

impl AsyncWrite for PipeWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }
        loop {
            let mut guard = ready!(self.0.poll_write_ready(context))?;
            match guard.try_io(|inner| inner.get_ref().write(bytes)) {
                Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => continue,
                Ok(result) => return Poll::Ready(result),
                Err(_would_block) => continue,
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

pub fn run_private(boot_nonce: Uuid, cwd: &Path) -> io::Result<()> {
    if boot_nonce.is_nil()
        || !cwd.is_absolute()
        || cwd.canonicalize()?.as_os_str() != cwd.as_os_str()
        || cwd != std::env::current_dir()?.canonicalize()?
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private birth must bind a nonnil nonce and the canonical actual cwd",
        ));
    }
    let paths = Arg0DispatchPaths {
        codex_self_exe: Some(std::env::current_exe()?.canonicalize()?),
        codex_linux_sandbox_exe: None,
        main_execve_wrapper_exe: None,
    };
    let input = File::from(io::stdin().as_fd().try_clone_to_owned()?);
    let output = File::from(io::stdout().as_fd().try_clone_to_owned()?);
    let cwd = cwd.to_path_buf();
    std::thread::Builder::new()
        .name("cmux-codex-entry".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_stack_size(16 * 1024 * 1024)
                .enable_all()
                .build()?;
            runtime.block_on(async move {
                let input = PipeReader::new(input)?;
                let output = PipeWriter::new(output)?;
                let validated = crate::capture::ClosedProfile::new(paths)
                    .capture(boot_nonce, &cwd)
                    .await?;
                crate::bridge::serve(input, output, validated).await
            })
        })?
        .join()
        .map_err(|_| io::Error::other("private coding entry thread panicked"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::{Future, poll_fn};
    use std::io::{Read, Write};
    use std::os::fd::OwnedFd;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn reader(file: impl Into<OwnedFd>) -> PipeReader {
        PipeReader::new(File::from(file.into())).expect("CMUX_PRIVATE_PIPE_UNAVAILABLE: reader")
    }

    fn writer(file: impl Into<OwnedFd>) -> PipeWriter {
        PipeWriter::new(File::from(file.into())).expect("CMUX_PRIVATE_PIPE_UNAVAILABLE: writer")
    }

    #[tokio::test]
    async fn cmux_entry_pipe_empty_read_parks_then_wakes_for_literal() -> io::Result<()> {
        let (input, mut peer) = io::pipe()?;
        let mut input = reader(input);
        let mut byte = [0];
        poll_fn(|context| {
            let mut buffer = ReadBuf::new(&mut byte);
            assert!(
                Pin::new(&mut input)
                    .poll_read(context, &mut buffer)
                    .is_pending(),
                "empty owned pipe did not park"
            );
            Poll::Ready(())
        })
        .await;
        peer.write_all(b"x")?;
        input.read_exact(&mut byte).await?;
        assert_eq!(byte, *b"x");
        Ok(())
    }

    #[tokio::test]
    async fn cmux_entry_pipe_eof_preserves_all_preceding_bytes() -> io::Result<()> {
        let (input, mut peer) = io::pipe()?;
        let mut input = reader(input);
        peer.write_all(b"literal\n")?;
        drop(peer);
        let mut bytes = Vec::new();
        input.read_to_end(&mut bytes).await?;
        assert_eq!(bytes, b"literal\n");
        assert_eq!(input.read(&mut [0]).await?, 0);
        Ok(())
    }

    #[test]
    fn cmux_entry_pipe_cancelled_pending_read_drops_runtime_without_peer_eof() -> io::Result<()> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let (input, mut peer) = io::pipe()?;
        runtime.block_on(async {
            let mut input = reader(input);
            let mut byte = [0];
            let mut read = Box::pin(input.read(&mut byte));
            poll_fn(|context| {
                assert!(read.as_mut().poll(context).is_pending());
                Poll::Ready(())
            })
            .await;
            drop(read);
            drop(input);
        });
        drop(runtime);
        assert_eq!(
            peer.write_all(b"x").unwrap_err().kind(),
            io::ErrorKind::BrokenPipe
        );
        Ok(())
    }

    #[tokio::test]
    async fn cmux_entry_pipe_write_and_flush_preserve_literal_bytes() -> io::Result<()> {
        let (mut peer, output) = io::pipe()?;
        let mut output = writer(output);
        output.write_all(b"literal\n").await?;
        output.flush().await?;
        let mut bytes = [0; 8];
        peer.read_exact(&mut bytes)?;
        assert_eq!(&bytes, b"literal\n");
        Ok(())
    }

    #[tokio::test]
    async fn cmux_entry_pipe_backpressure_parks_and_resumes_after_peer_drain() -> io::Result<()> {
        let (mut peer, output) = io::pipe()?;
        let mut output = writer(output);
        output.write_all(&[b'x'; 4096]).await?;
        let filled = poll_fn(|context| {
            let mut total = 4096;
            loop {
                match Pin::new(&mut output).poll_write(context, &[b'x'; 4096]) {
                    Poll::Pending => return Poll::Ready(total),
                    Poll::Ready(Ok(count)) => {
                        assert!(count > 0);
                        total += count;
                        assert!(total <= 16 * 1024 * 1024, "unbounded owned pipe buffering");
                    }
                    Poll::Ready(Err(error)) => panic!("write before backpressure: {error}"),
                }
            }
        })
        .await;
        assert!(filled > 0);
        let mut drained = vec![0; filled];
        peer.read_exact(&mut drained)?;
        assert!(drained.iter().all(|byte| *byte == b'x'));
        output.write_all(b"tail").await?;
        let mut tail = [0; 4];
        peer.read_exact(&mut tail)?;
        assert_eq!(&tail, b"tail");
        Ok(())
    }

    #[tokio::test]
    async fn cmux_entry_pipe_broken_output_returns_explicit_error() -> io::Result<()> {
        let (peer, output) = io::pipe()?;
        let mut output = writer(output);
        drop(peer);
        assert_eq!(
            output.write_all(b"x").await.unwrap_err().kind(),
            io::ErrorKind::BrokenPipe
        );
        Ok(())
    }

    #[tokio::test]
    async fn cmux_entry_pipe_refuses_regular_files_and_wrong_direction() -> io::Result<()> {
        assert!(PipeReader::new(tempfile::tempfile()?).is_err());
        assert!(PipeWriter::new(tempfile::tempfile()?).is_err());
        let (input, output) = io::pipe()?;
        assert!(PipeReader::new(File::from(OwnedFd::from(output))).is_err());
        assert!(PipeWriter::new(File::from(OwnedFd::from(input))).is_err());
        Ok(())
    }

    #[tokio::test]
    async fn cmux_entry_pipe_zero_length_io_never_waits_for_peer() -> io::Result<()> {
        let (input, _peer) = io::pipe()?;
        let (_peer, output) = io::pipe()?;
        let mut input = reader(input);
        let mut output = writer(output);
        poll_fn(|context| {
            let mut buffer = ReadBuf::new(&mut []);
            assert!(matches!(
                Pin::new(&mut input).poll_read(context, &mut buffer),
                Poll::Ready(Ok(()))
            ));
            assert!(matches!(
                Pin::new(&mut output).poll_write(context, &[]),
                Poll::Ready(Ok(0))
            ));
            Poll::Ready(())
        })
        .await;
        Ok(())
    }
}
