declare namespace NodeJS {
  /*
   * Dev checks read the bare `process.env.NODE_ENV`, which Vite, Next.js and webpack
   * replace at build time. This declares it for apps without @types/node (Vite apps use
   * `types: ["vite/client"]`), so they still typecheck. It matches @types/node's own
   * declarations, so apps that have them are unaffected.
   */
  interface ProcessEnv {
    NODE_ENV?: string | undefined;
  }
  interface Process {
    env: ProcessEnv;
  }
}
// eslint-disable-next-line no-var
declare var process: NodeJS.Process;
