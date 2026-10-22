use std::fs::File;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

pub(crate) struct PipeReader;
pub(crate) struct PipeWriter;

fn unavailable() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "owned nonblocking pipes unavailable",
    )
}

impl PipeReader {
    pub(crate) fn new(_file: File) -> io::Result<Self> {
        Err(unavailable())
    }
}

impl PipeWriter {
    pub(crate) fn new(_file: File) -> io::Result<Self> {
        Err(unavailable())
    }
}

impl AsyncRead for PipeReader {
    fn poll_read(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        _buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Err(unavailable()))
    }
}

impl AsyncWrite for PipeWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        _bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(unavailable()))
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Err(unavailable()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Err(unavailable()))
    }
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
        let filled = poll_fn(|context| {
            let mut total = 0;
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
