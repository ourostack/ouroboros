#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>

enum {
  EXIT_USAGE = 64,
  EXIT_UNAVAILABLE = 69,
};

static int parse_pid(const char *text, pid_t *pid_out) {
  if (text == NULL || text[0] == '\0' || text[0] == '0') return 0;
  for (const unsigned char *cursor = (const unsigned char *)text; *cursor != '\0'; cursor += 1) {
    if (*cursor < '0' || *cursor > '9') return 0;
  }
  errno = 0;
  char *end = NULL;
  const long value = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value <= 0 || value > INT_MAX) return 0;
  *pid_out = (pid_t)value;
  return 1;
}

static int write_json_string(const char *value) {
  const unsigned char *cursor = (const unsigned char *)value;
  while (*cursor != '\0') {
    const unsigned char byte = *cursor;
    if (byte == '"' || byte == '\\') {
      if (putchar('\\') == EOF || putchar(byte) == EOF) return 0;
    } else if (byte < 0x20) {
      if (printf("\\u%04x", (unsigned int)byte) < 0) return 0;
    } else if (putchar(byte) == EOF) {
      return 0;
    }
    cursor += 1;
  }
  return 1;
}

static int emit_proof(pid_t pid) {
  struct proc_bsdinfo info;
  memset(&info, 0, sizeof(info));
  const int info_bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, (int)sizeof(info));
  if (info_bytes != (int)sizeof(info)) return 0;
  if (info.pbi_start_tvusec > 999999U) return 0;

  char observed_path[PROC_PIDPATHINFO_MAXSIZE];
  memset(observed_path, 0, sizeof(observed_path));
  const int path_bytes = proc_pidpath(pid, observed_path, (uint32_t)sizeof(observed_path));
  if (path_bytes <= 0 || path_bytes >= (int)sizeof(observed_path)) return 0;
  observed_path[path_bytes] = '\0';

  char resolved_path[PATH_MAX];
  if (realpath(observed_path, resolved_path) == NULL) return 0;

  if (fputs("{\"executableRealpath\":\"", stdout) == EOF) return 0;
  if (!write_json_string(resolved_path)) return 0;
  if (printf(
        "\",\"pid\":%d,\"schemaVersion\":1,\"startIdentity\":\"darwin-proc:%llu:%06u\",\"uid\":%u}\n",
        (int)pid,
        (unsigned long long)info.pbi_start_tvsec,
        (unsigned int)info.pbi_start_tvusec,
        (unsigned int)info.pbi_uid
      ) < 0) {
    return 0;
  }
  return fflush(stdout) == 0;
}

int main(int argc, char **argv) {
  pid_t pid = 0;
  if (argc != 3 || strcmp(argv[1], "--pid") != 0 || !parse_pid(argv[2], &pid)) {
    fputs("usage: process-proof-darwin --pid <decimal>\n", stderr);
    return EXIT_USAGE;
  }
  if (!emit_proof(pid)) {
    fputs("process proof unavailable\n", stderr);
    return EXIT_UNAVAILABLE;
  }
  return 0;
}
