#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>

#ifndef OURO_PROC_PIDINFO
#define OURO_PROC_PIDINFO proc_pidinfo
#endif
#ifndef OURO_PROC_PIDPATH
#define OURO_PROC_PIDPATH proc_pidpath
#endif
#ifndef OURO_REALPATH
#define OURO_REALPATH realpath
#endif
#ifndef OURO_FPUTS
#define OURO_FPUTS fputs
#endif
#ifndef OURO_PUTCHAR
#define OURO_PUTCHAR putchar
#endif
#ifndef OURO_PRINTF
#define OURO_PRINTF printf
#endif
#ifndef OURO_FFLUSH
#define OURO_FFLUSH fflush
#endif

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
  if (errno != 0 || value > INT_MAX) return 0;
  *pid_out = (pid_t)value;
  return 1;
}

static int write_json_string(const char *value) {
  const unsigned char *cursor = (const unsigned char *)value;
  while (*cursor != '\0') {
    const unsigned char byte = *cursor;
    if (byte == '"' || byte == '\\') {
      if (OURO_PUTCHAR('\\') == EOF || OURO_PUTCHAR(byte) == EOF) return 0;
    } else if (byte < 0x20) {
      if (OURO_PRINTF("\\u%04x", (unsigned int)byte) < 0) return 0;
    } else if (OURO_PUTCHAR(byte) == EOF) {
      return 0;
    }
    cursor += 1;
  }
  return 1;
}

static int emit_proof(pid_t pid) {
  struct proc_bsdinfo info;
  memset(&info, 0, sizeof(info));
  const int info_bytes = OURO_PROC_PIDINFO(pid, PROC_PIDTBSDINFO, 0, &info, (int)sizeof(info));
  if (info_bytes != (int)sizeof(info)) return 0;
  if (info.pbi_start_tvusec > 999999U) return 0;

  char observed_path[PROC_PIDPATHINFO_MAXSIZE];
  memset(observed_path, 0, sizeof(observed_path));
  const int path_bytes = OURO_PROC_PIDPATH(pid, observed_path, (uint32_t)sizeof(observed_path));
  if (path_bytes <= 0 || path_bytes >= (int)sizeof(observed_path)) return 0;
  observed_path[path_bytes] = '\0';

  char resolved_path[PATH_MAX];
  if (OURO_REALPATH(observed_path, resolved_path) == NULL) return 0;

  if (OURO_FPUTS("{\"executableRealpath\":\"", stdout) == EOF) return 0;
  if (!write_json_string(resolved_path)) return 0;
  if (OURO_PRINTF(
        "\",\"pid\":%d,\"schemaVersion\":1,\"startIdentity\":\"darwin-proc:%llu:%06u\",\"uid\":%u}\n",
        (int)pid,
        (unsigned long long)info.pbi_start_tvsec,
        (unsigned int)info.pbi_start_tvusec,
        (unsigned int)info.pbi_uid
      ) < 0) {
    return 0;
  }
  return OURO_FFLUSH(stdout) == 0;
}

int main(int argc, char **argv) {
  pid_t pid = 0;
  if (argc != 3 || strcmp(argv[1], "--pid") != 0 || !parse_pid(argv[2], &pid)) {
    OURO_FPUTS("usage: process-proof-darwin --pid <decimal>\n", stderr);
    return EXIT_USAGE;
  }
  if (!emit_proof(pid)) {
    OURO_FPUTS("process proof unavailable\n", stderr);
    return EXIT_UNAVAILABLE;
  }
  return 0;
}
