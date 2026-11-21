// Run under --import guard.mjs: `net <host> <port>` opens a socket, `fetch <url>` fetches, `dgram <host> <port>`
// sends one datagram and `dgram-connect <host> <port>` connects a datagram socket.
import dgram from "node:dgram";
import net from "node:net";

const [mode, target, port] = process.argv.slice(2);
if (mode === "net") {
  const socket = net.connect(Number(port), target);
  socket.on("connect", () => {
    console.log("connected");
    socket.destroy();
  });
  socket.on("error", (error) => {
    console.log(`not refused by the guard: ${error.code}`);
  });
} else if (mode === "dgram" || mode === "dgram-connect") {
  const socket = dgram.createSocket("udp4");
  const done = () => {
    console.log("sent");
    socket.close();
  };
  if (mode === "dgram") socket.send("x", Number(port), target, done);
  else socket.connect(Number(port), target, done);
} else {
  const response = await fetch(target);
  console.log(`fetched ${response.status}`);
}
