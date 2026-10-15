#include <errno.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>

static void json_string(const char *s) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32 || *p == 127) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}

static int unknown(const char *reason) {
  printf("{\"state\":\"unknown\",\"reason\":");
  json_string(reason);
  puts("}");
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 2) return unknown("pid-invalid");
  char *end = NULL;
  errno = 0;
  long parsed = strtol(argv[1], &end, 10);
  if (errno || !end || *end || parsed <= 0 || parsed > INT32_MAX) return unknown("pid-invalid");
  pid_t pid = (pid_t)parsed;
  struct proc_bsdinfo before = {0}, after = {0};
  errno = 0;
  int got = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before));
  if (got != sizeof(before)) {
    if (errno == ESRCH || errno == ENOENT) { puts("{\"state\":\"absent\"}"); return 0; }
    return unknown("birth-unavailable");
  }
  char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (proc_pidpath(pid, executable, sizeof(executable)) <= 0) return unknown("path-unavailable");
  struct proc_vnodepathinfo vnode = {0};
  int cwd_available = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &vnode, sizeof(vnode)) == sizeof(vnode);
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after) ||
      before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec ||
      before.pbi_ppid != after.pbi_ppid || before.pbi_uid != after.pbi_uid) return unknown("generation-changed");
  printf("{\"state\":\"present\",\"generation\":{\"pid\":%u,\"birth\":\"darwin:%llu:%llu\",\"uid\":%u},\"parentPid\":%u,\"processGroupId\":%u,\"foregroundProcessGroupId\":",
    before.pbi_pid, (unsigned long long)before.pbi_start_tvsec, (unsigned long long)before.pbi_start_tvusec,
    before.pbi_uid, before.pbi_ppid, before.pbi_pgid);
  if ((before.pbi_flags & PROC_FLAG_CTTY) && before.e_tpgid > 0 && before.e_tpgid <= INT32_MAX) printf("%u", before.e_tpgid);
  else printf("null");
  printf(",\"ttyDevice\":");
  if (before.pbi_flags & PROC_FLAG_CTTY) printf("%u", before.e_tdev);
  else printf("null");
  printf(",\"executable\":");
  json_string(executable);
  printf(",\"entryScript\":null");
  printf(",\"cwd\":");
  if (cwd_available && vnode.pvi_cdir.vip_path[0]) json_string(vnode.pvi_cdir.vip_path); else printf("null");
  puts("}");
  return 0;
}
